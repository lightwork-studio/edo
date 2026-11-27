import type { Recipe } from "@edo/core";
import { Pressable, Text, View } from "react-native";
import type { Strings } from "./strings";
import { displayAmount, Notice, styles } from "./ui";

export function RecipeList({
  t,
  locale,
  recipes,
  onCreate,
  onEdit,
  onPick,
  onRetry,
}: {
  t: Strings;
  locale: string;
  recipes: readonly Recipe[] | null;
  onCreate: () => void;
  onEdit: (recipe: Recipe) => void;
  onPick: (recipe: Recipe) => void;
  onRetry: () => void;
}) {
  const names = new Intl.Collator(locale);
  const ordered = recipes
    ? [...recipes].sort(
        (left, right) => names.compare(left.name, right.name) || left.id.localeCompare(right.id),
      )
    : null;
  return (
    <>
      <View style={styles.row}>
        <Text accessibilityRole="header" style={[styles.title, styles.stretch]}>
          {t.recipes}
        </Text>
        {ordered && (
          <Pressable accessibilityRole="button" onPress={onCreate} style={styles.action}>
            <Text style={styles.actionText}>{t.createRecipe}</Text>
          </Pressable>
        )}
      </View>
      {ordered === null && (
        <Notice text={t.recipeReadError} action={{ label: t.retry, onPress: onRetry }} />
      )}
      {ordered?.map((recipe) => (
        <View key={recipe.id} style={[styles.card, styles.row]}>
          <Pressable
            accessibilityRole="button"
            accessibilityHint={t.addFood}
            style={[styles.stretch, { minHeight: 44, justifyContent: "center" }]}
            onPress={() => onPick(recipe)}
          >
            <Text style={styles.title}>{recipe.name}</Text>
            <Text style={styles.meta}>
              {t.recipeServings(displayAmount(recipe.servings, locale), recipe.servings)}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.editCustomFoodName(recipe.name)}
            onPress={() => onEdit(recipe)}
            style={styles.action}
          >
            <Text style={styles.actionText}>{t.editCustomFood}</Text>
          </Pressable>
        </View>
      ))}
    </>
  );
}
