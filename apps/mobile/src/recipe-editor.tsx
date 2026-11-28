import { type Food, type Portion, type Recipe, roundNutritionForDisplay } from "@edo/core";
import type { PackagedFoodCache } from "@edo/storage";
import { useEffect, useRef, useState } from "react";
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { openFoodFactsLicenseUrl } from "./barcode";
import { type CatalogDatabase, searchBls } from "./catalog";
import { SourceLink } from "./catalog-source-link";
import { readAmount } from "./diary-view";
import { searchCachedPackagedFoods } from "./packaged-food-search";
import {
  type IngredientDraft,
  ingredientUnitChange,
  ingredientUnits,
  newRecipeIngredient,
  previewRecipe,
  recipeIngredient,
  recipeIngredientNutrition,
} from "./recipe-form";
import { type Language, strings } from "./strings";
import {
  colors,
  displayAmount,
  displayNumber,
  IconButton,
  macros,
  Notice,
  nutrientValue,
  PrimaryButton,
  styles,
} from "./ui";

const copy = {
  en: {
    create: "Create recipe",
    edit: "Edit recipe",
    name: "Recipe name",
    servings: "Servings",
    cookedWeight: "Cooked weight (optional)",
    perServing: "Per serving",
    ingredients: "Ingredients",
    customFood: "Custom food",
    total: "total",
    add: "Add ingredient",
    close: "Close ingredient search",
    search: "Search ingredients",
    remove: (name: string) => `Remove ${name}`,
    ingredientAmount: (name: string) => `${name} amount`,
    unit: (name: string) => `${name} unit`,
    nameError: "Enter a recipe name.",
    ingredientsError: "Add at least one ingredient.",
    amountsError: "Enter a valid amount for each ingredient.",
    servingsError: "Enter a number of servings greater than zero.",
    weightError: "Enter a cooked weight greater than zero or leave it blank.",
    ingredientError: "Couldn’t add this ingredient.",
    save: "Save recipe",
    saveError: "Couldn’t save the recipe. Try again.",
    catalogUnavailable: "BLS search is currently unavailable.",
  },
  de: {
    create: "Rezept erstellen",
    edit: "Rezept bearbeiten",
    name: "Rezeptname",
    servings: "Portionen",
    cookedWeight: "Gewicht nach dem Kochen (optional)",
    perServing: "Pro Portion",
    ingredients: "Zutaten",
    customFood: "Eigenes Lebensmittel",
    total: "gesamt",
    add: "Zutat hinzufügen",
    close: "Zutatensuche schließen",
    search: "Zutaten suchen",
    remove: (name: string) => `${name} entfernen`,
    ingredientAmount: (name: string) => `Menge für ${name}`,
    unit: (name: string) => `Einheit für ${name}`,
    nameError: "Gib einen Rezeptnamen ein.",
    ingredientsError: "Füge mindestens eine Zutat hinzu.",
    amountsError: "Gib für jede Zutat eine gültige Menge ein.",
    servingsError: "Gib eine Portionsanzahl größer als null ein.",
    weightError: "Gib ein Gewicht größer als null ein oder lass das Feld frei.",
    ingredientError: "Die Zutat konnte nicht hinzugefügt werden.",
    save: "Rezept speichern",
    saveError: "Das Rezept konnte nicht gespeichert werden. Versuche es erneut.",
    catalogUnavailable: "Die BLS-Suche ist gerade nicht verfügbar.",
  },
};

type RecipeCopy = (typeof copy)[Language];
type PortionChanges = Partial<Pick<IngredientDraft, "amount" | "unit">>;

export function RecipeEditor({
  language,
  locale,
  current,
  customFoods,
  catalog,
  packagedCache,
  refreshIngredient,
  onCatalogRetry,
  newItemId,
  onBack,
  onSave,
}: {
  language: Language;
  locale: string;
  current: Recipe | null;
  customFoods: readonly Food[];
  catalog: CatalogDatabase | "error" | null;
  packagedCache: PackagedFoodCache | null;
  refreshIngredient: (food: Food, signal: AbortSignal) => Promise<Food | null> | null;
  onCatalogRetry: () => void;
  newItemId: () => string;
  onBack: () => void;
  onSave: (draft: Omit<Recipe, "id">) => void;
}) {
  const t = strings[language];
  const words = copy[language];
  const [name, setName] = useState(current?.name ?? "");
  const [servingsText, setServingsText] = useState<string>();
  const [weightText, setWeightText] = useState<string>();
  const [ingredients, setIngredients] = useState<IngredientDraft[]>(() =>
    (current?.ingredients ?? []).map((original) => ({ original, unit: original.portion.unit })),
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [addFailed, setAddFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const ingredientRefresh = useRef<AbortController | null>(null);
  const submitted = useRef(false);
  useEffect(() => () => ingredientRefresh.current?.abort(), []);
  const servings = servingsText === undefined ? (current?.servings ?? 1) : readAmount(servingsText);
  const cookedWeightG =
    weightText === undefined
      ? current?.cookedWeightG
      : weightText.trim()
        ? readAmount(weightText)
        : undefined;
  const items = ingredients.map(recipeIngredient);
  const validItems = items.filter((item) => item !== null);
  const invalidPortions = validItems.length !== ingredients.length;
  const preview = invalidPortions ? null : previewRecipe(name, validItems, servings, cookedWeightG);
  let error: string | undefined;
  if (attemptedSave) {
    if (!name.trim()) error = words.nameError;
    else if (servings === null) error = words.servingsError;
    else if (cookedWeightG === null) error = words.weightError;
    else if (!ingredients.length) error = words.ingredientsError;
    else if (invalidPortions || !preview) error = words.amountsError;
    else if (saveFailed) error = words.saveError;
  }

  function submit() {
    if (submitted.current || ingredientRefresh.current) return;
    setAttemptedSave(true);
    if (!preview?.draft.name) return;
    submitted.current = true;
    try {
      onSave(preview.draft);
      Keyboard.dismiss();
    } catch {
      submitted.current = false;
      setSaveFailed(true);
    }
  }

  function appendIngredient(food: Food) {
    try {
      const ingredient = newRecipeIngredient(newItemId(), food);
      setIngredients((items) => [...items, ingredient]);
      setSearchOpen(false);
      setAddFailed(false);
      Keyboard.dismiss();
    } catch {
      setAddFailed(true);
    }
  }

  function addIngredient(food: Food) {
    if (ingredientRefresh.current) return;
    const controller = new AbortController();
    const updated = refreshIngredient(food, controller.signal);
    if (!updated) {
      appendIngredient(food);
      return;
    }
    ingredientRefresh.current = controller;
    setRefreshing(true);
    setAddFailed(false);
    void updated
      .catch(() => null)
      .then((fresh) => {
        if (controller.signal.aborted) return;
        ingredientRefresh.current = null;
        setRefreshing(false);
        appendIngredient(fresh ?? food);
      });
  }

  return (
    <>
      <View style={styles.header}>
        <IconButton label={t.back} glyph="‹" onPress={onBack} />
        <Text accessibilityRole="header" style={styles.title}>
          {current ? words.edit : words.create}
        </Text>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <TextInput
          accessibilityLabel={words.name}
          placeholder={words.name}
          placeholderTextColor={colors.muted}
          value={name}
          onChangeText={setName}
          style={[local.field, local.name]}
        />
        <View style={local.yield}>
          <View style={local.yieldCard}>
            <Text style={styles.meta}>{words.servings}</Text>
            <TextInput
              accessibilityLabel={words.servings}
              inputMode="decimal"
              value={servingsText ?? displayAmount(current?.servings ?? 1, locale)}
              onChangeText={setServingsText}
              selectTextOnFocus
              style={local.yieldInput}
            />
          </View>
          <View style={local.yieldCard}>
            <Text style={styles.meta}>{words.cookedWeight}</Text>
            <View style={local.yield}>
              <TextInput
                accessibilityLabel={`${words.cookedWeight} (g)`}
                inputMode="decimal"
                placeholder="—"
                placeholderTextColor={colors.muted}
                value={
                  weightText ??
                  (current?.cookedWeightG === undefined
                    ? ""
                    : displayAmount(current.cookedWeightG, locale))
                }
                onChangeText={setWeightText}
                selectTextOnFocus
                style={[local.yieldInput, styles.stretch]}
              />
              <Text style={styles.meta}>g</Text>
            </View>
          </View>
        </View>
        {preview && (
          <ServingPreview
            preview={preview.portion}
            words={words}
            language={language}
            locale={locale}
          />
        )}
        <View style={styles.row}>
          <Text accessibilityRole="header" style={[styles.title, styles.stretch]}>
            {words.ingredients}
            {ingredients.length > 0 && <Text style={styles.meta}> · {ingredients.length}</Text>}
          </Text>
          {preview && (
            <Text style={styles.meta}>
              {nutrientValue(roundNutritionForDisplay(preview.batch).kcal, locale, "kcal")}{" "}
              {words.total}
            </Text>
          )}
        </View>
        {ingredients.length > 0 && (
          <View style={local.ingredients}>
            {ingredients.map((ingredient, index) => (
              <IngredientRow
                key={ingredient.original.id}
                draft={ingredient}
                kcal={
                  items[index]
                    ? roundNutritionForDisplay(recipeIngredientNutrition(items[index])).kcal
                    : null
                }
                language={language}
                locale={locale}
                onChange={(changes) =>
                  setIngredients((items) =>
                    items.map((item) =>
                      item.original.id === ingredient.original.id ? { ...item, ...changes } : item,
                    ),
                  )
                }
                onRemove={() =>
                  setIngredients((items) =>
                    items.filter((item) => item.original.id !== ingredient.original.id),
                  )
                }
              />
            ))}
          </View>
        )}
        {!searchOpen &&
          ingredients.some(({ original }) => original.food.id.provider === "open-food-facts") && (
            <SourceLink uri={openFoodFactsLicenseUrl} title={t.openFoodFactsLicense} />
          )}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: searchOpen }}
          onPress={() => {
            ingredientRefresh.current?.abort();
            ingredientRefresh.current = null;
            setRefreshing(false);
            setSearchOpen(!searchOpen);
            setAddFailed(false);
          }}
          style={({ pressed }) => [local.add, pressed && styles.pressed]}
        >
          <Text style={styles.actionText}>{searchOpen ? words.close : `+  ${words.add}`}</Text>
        </Pressable>
        {searchOpen && (
          <IngredientSearch
            catalog={catalog}
            packagedCache={packagedCache}
            refreshing={refreshing}
            onCatalogRetry={onCatalogRetry}
            customFoods={customFoods}
            language={language}
            onPick={addIngredient}
          />
        )}
        {addFailed && (
          <Text accessibilityRole="alert" style={styles.error}>
            {words.ingredientError}
          </Text>
        )}
      </ScrollView>
      <View style={[styles.footer, local.footer]}>
        {error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        <PrimaryButton title={words.save} onPress={submit} disabled={refreshing} />
      </View>
    </>
  );
}

function ServingPreview({
  preview,
  words,
  language,
  locale,
}: {
  preview: Food["nutrition"];
  words: RecipeCopy;
  language: Language;
  locale: string;
}) {
  const nutrients = roundNutritionForDisplay(preview.nutrients);
  const grams = preview.portionSize?.amount;
  return (
    <View style={local.preview}>
      <View style={local.previewEnergy}>
        <Text style={[styles.heading, styles.numbers]}>
          {nutrientValue(nutrients.kcal, locale, "kcal")}
        </Text>
        <Text accessibilityRole="header" style={styles.meta}>
          {words.perServing}
          {grams !== undefined && ` · ${displayNumber(grams, locale)} g`}
        </Text>
      </View>
      <View style={local.macroGroup}>
        {macros.map(({ label, nutrient, color }) => (
          <View key={nutrient} style={local.macro}>
            <Text style={[styles.body, styles.numbers, { color }]}>
              {nutrientValue(nutrients[nutrient], locale, "g")}
            </Text>
            <Text style={styles.meta}>{strings[language][label]}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function IngredientRow({
  draft,
  kcal,
  language,
  locale,
  onChange,
  onRemove,
}: {
  draft: IngredientDraft;
  kcal: number | null;
  language: Language;
  locale: string;
  onChange: (changes: PortionChanges) => void;
  onRemove: () => void;
}) {
  const [unitOpen, setUnitOpen] = useState(false);
  const { original, unit } = draft;
  const name = original.food.name;
  const t = strings[language];
  const words = copy[language];
  const units = ingredientUnits(draft);
  const unitName = (unit: Portion["unit"]) => (unit === "portion" ? t.portion : unit);
  return (
    <View style={local.ingredient}>
      <View style={local.ingredientLine}>
        <View style={styles.stretch}>
          <Text style={styles.body}>{name}</Text>
          {original.food.id.provider === "open-food-facts" && (
            <Text style={styles.meta}>{t.openFoodFactsCredit}</Text>
          )}
        </View>
        <View style={local.amount}>
          <TextInput
            accessibilityLabel={`${words.ingredientAmount(name)} (${unitName(unit)})`}
            inputMode="decimal"
            value={draft.amount ?? displayAmount(original.portion.amount, locale)}
            onChangeText={(amount) => onChange({ amount })}
            selectTextOnFocus
            style={local.amountInput}
          />
          {units.length === 1 ? (
            <Text style={styles.meta}>{unitName(unit)}</Text>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: unitOpen }}
              accessibilityLabel={`${words.unit(name)}, ${unitName(unit)}`}
              onPress={() => setUnitOpen(!unitOpen)}
              style={local.unit}
            >
              <Text style={styles.actionText}>{unitName(unit)} ⌄</Text>
            </Pressable>
          )}
        </View>
        <Text style={[styles.meta, styles.numbers]}>{nutrientValue(kcal, locale, "kcal")}</Text>
        <IconButton label={words.remove(name)} glyph="×" onPress={onRemove} />
      </View>
      {unitOpen && (
        <View style={local.units}>
          {units.map((choice) => (
            <Pressable
              key={choice}
              accessibilityRole="button"
              accessibilityState={{ selected: unit === choice }}
              onPress={() => {
                onChange(ingredientUnitChange(draft, choice));
                setUnitOpen(false);
              }}
              style={[local.unitOption, unit === choice && local.selected]}
            >
              <Text style={unit === choice ? styles.actionText : styles.body}>
                {unitName(choice)}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function IngredientSearch({
  catalog,
  packagedCache,
  refreshing,
  onCatalogRetry,
  customFoods,
  language,
  onPick,
}: {
  catalog: CatalogDatabase | "error" | null;
  packagedCache: PackagedFoodCache | null;
  refreshing: boolean;
  onCatalogRetry: () => void;
  customFoods: readonly Food[];
  language: Language;
  onPick: (food: Food) => void;
}) {
  const t = strings[language];
  const words = copy[language];
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    catalog: CatalogDatabase | "error" | null;
    packagedCache: PackagedFoodCache | null;
    query: string;
    language: Language;
    attempt: number;
    bls: Food[] | null | undefined;
    cached: Food[];
  }>();
  const term = query.trim();
  useEffect(() => {
    if (!term) return;
    let active = true;
    const timer = setTimeout(() => {
      const snapshot = {
        catalog,
        packagedCache,
        query: term,
        language,
        attempt,
        cached: searchCachedPackagedFoods(packagedCache, term),
      };
      setResult({ ...snapshot, bls: undefined });
      if (catalog && catalog !== "error") {
        void searchBls(catalog, term, language)
          .catch(() => null)
          .then((bls) => {
            if (active) setResult({ ...snapshot, bls });
          });
      }
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [catalog, packagedCache, term, language, attempt]);

  const fold = (value: string) => value.normalize("NFC").toLocaleLowerCase(language);
  const normalized = fold(term);
  const matches = customFoods.filter((food) => fold(food.name).includes(normalized));
  const latest =
    term &&
    result?.catalog === catalog &&
    result.packagedCache === packagedCache &&
    result.query === term &&
    result.language === language &&
    result.attempt === attempt
      ? result
      : undefined;
  const bls = latest?.bls;
  const cached = latest?.cached ?? [];

  return (
    <View style={styles.card}>
      <TextInput
        accessibilityLabel={words.search}
        placeholder={words.search}
        placeholderTextColor={colors.muted}
        autoCorrect={false}
        clearButtonMode="while-editing"
        returnKeyType="search"
        editable={!refreshing}
        value={query}
        maxLength={120}
        onChangeText={setQuery}
        style={local.search}
      />
      {[...matches, ...(bls ?? []), ...cached].map((food) => (
        <Pressable
          key={`${food.id.provider}:${food.id.sourceId}`}
          accessibilityRole="button"
          accessibilityState={{ disabled: refreshing }}
          disabled={refreshing}
          onPress={() => onPick(food)}
          style={({ pressed }) => [styles.row, local.result, pressed && styles.pressed]}
        >
          <View style={styles.stretch}>
            <Text style={styles.body}>{food.name}</Text>
            <Text style={styles.meta}>
              {food.id.provider === "open-food-facts"
                ? t.openFoodFactsCredit
                : food.id.provider === "bls"
                  ? t.bls
                  : words.customFood}
            </Text>
          </View>
          <Text style={styles.actionText}>+</Text>
        </Pressable>
      ))}
      {cached.length > 0 && (
        <SourceLink uri={openFoodFactsLicenseUrl} title={t.openFoodFactsLicense} />
      )}
      {term !== "" && catalog === "error" && (
        <Notice
          text={words.catalogUnavailable}
          action={{ label: t.retry, onPress: onCatalogRetry }}
        />
      )}
      {(refreshing || (term !== "" && catalog !== "error" && bls === undefined)) && (
        <Notice text={t.loading} pending />
      )}
      {bls === null && (
        <Notice
          text={t.searchError}
          action={{ label: t.retry, onPress: () => setAttempt((value) => value + 1) }}
        />
      )}
      {term !== "" && matches.length === 0 && bls?.length === 0 && cached.length === 0 && (
        <Text style={styles.meta}>{t.noResults}</Text>
      )}
    </View>
  );
}

const local = StyleSheet.create({
  field: { color: colors.text, backgroundColor: colors.surface, borderRadius: 16 },
  name: { minHeight: 54, paddingHorizontal: 14, fontSize: 20, fontWeight: "700" },
  yield: { flexDirection: "row", alignItems: "center", gap: 10 },
  yieldCard: {
    flex: 1,
    alignSelf: "stretch",
    backgroundColor: colors.surface,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingTop: 10,
    justifyContent: "space-between",
  },
  yieldInput: { minHeight: 44, color: colors.text, fontSize: 20, paddingVertical: 4 },
  preview: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 14,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  previewEnergy: { gap: 2 },
  macroGroup: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  macro: { alignItems: "center", gap: 2 },
  ingredients: { backgroundColor: colors.surface, borderRadius: 16 },
  ingredient: {
    paddingHorizontal: 8,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  ingredientLine: { minHeight: 54, flexDirection: "row", alignItems: "center", gap: 8 },
  amount: {
    minHeight: 44,
    backgroundColor: colors.field,
    borderRadius: 22,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
  },
  amountInput: {
    width: 44,
    minHeight: 44,
    textAlign: "right",
    paddingVertical: 6,
    paddingRight: 3,
    color: colors.text,
    fontSize: 15,
  },
  unit: { minHeight: 44, minWidth: 44, justifyContent: "center", alignItems: "center" },
  units: { flexDirection: "row", justifyContent: "flex-end", gap: 8, paddingBottom: 8 },
  unitOption: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 22,
    justifyContent: "center",
    backgroundColor: colors.field,
  },
  selected: { backgroundColor: colors.accentSoft },
  add: {
    minHeight: 52,
    paddingHorizontal: 14,
    justifyContent: "center",
    borderRadius: 16,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border,
  },
  search: {
    minHeight: 48,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: colors.field,
    color: colors.text,
    fontSize: 16,
  },
  result: {
    minHeight: 44,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
  },
  footer: { gap: 8 },
});
