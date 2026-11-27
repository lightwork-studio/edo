import type { Food } from "@edo/core";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { Strings } from "./strings";
import { DetailHeader, Notice, nutrientValue, PrimaryButton, styles } from "./ui";

const bases = {
  "per-100-g": "per100g",
  "per-100-ml": "per100ml",
  "per-portion": "perPortion",
} as const;

export function CustomFoodList({
  t,
  locale,
  date,
  foods,
  onBack,
  onCreate,
  onEdit,
  onPick,
  onRetry,
}: {
  t: Strings;
  locale: string;
  date: string;
  foods: readonly Food[] | null;
  onBack: () => void;
  onCreate: () => void;
  onEdit: (food: Food) => void;
  onPick: (food: Food) => void;
  onRetry: () => void;
}) {
  return (
    <>
      <DetailHeader title={t.myFoods} subtitle={date} back={t.back} onBack={onBack} />
      {foods === null ? (
        <Notice text={t.myFoodsError} action={{ label: t.retry, onPress: onRetry }} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {foods.length === 0 && <Notice text={t.noCustomFoods} />}
          {foods.map((food) => (
            <View key={food.id.sourceId} style={[styles.card, styles.row]}>
              <Pressable
                accessibilityRole="button"
                accessibilityHint={t.addFood}
                style={[styles.stretch, { minHeight: 44, justifyContent: "center" }]}
                onPress={() => onPick(food)}
              >
                <Text style={styles.title}>{food.name}</Text>
                <Text style={styles.meta}>
                  {nutrientValue(food.nutrition.nutrients.kcal, locale, "kcal")} ·{" "}
                  {t[bases[food.nutrition.basis]]}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t.editCustomFoodName(food.name)}
                onPress={() => onEdit(food)}
                style={styles.action}
              >
                <Text style={styles.actionText}>{t.editCustomFood}</Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}
      {foods !== null && (
        <View style={styles.footer}>
          <PrimaryButton title={t.createCustomFood} onPress={onCreate} />
        </View>
      )}
    </>
  );
}
