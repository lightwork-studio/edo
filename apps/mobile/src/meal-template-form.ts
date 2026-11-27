import type { DiaryItem, DiaryMeal } from "@edo/core";

export interface MealTemplateOption {
  readonly item: DiaryItem;
  readonly occurredAt: number;
  readonly utcOffsetMinutes?: number;
  readonly initiallySelected: boolean;
}

export function mealTemplateOptions(
  chosenMeal: DiaryMeal,
  diaryMeals: readonly DiaryMeal[],
): MealTemplateOption[] {
  return diaryMeals
    .filter((meal) => meal.localDay === chosenMeal.localDay)
    .flatMap((meal) =>
      meal.items.map((item) => ({
        item,
        occurredAt: meal.occurredAt,
        ...(meal.utcOffsetMinutes !== undefined && { utcOffsetMinutes: meal.utcOffsetMinutes }),
        initiallySelected: meal.id === chosenMeal.id,
      })),
    );
}

export function selectedMealItems(
  options: readonly MealTemplateOption[],
  selected: ReadonlySet<string>,
): DiaryItem[] {
  return options.filter(({ item }) => selected.has(item.id)).map(({ item }) => item);
}
