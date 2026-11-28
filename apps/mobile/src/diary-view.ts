import {
  createDiaryItem,
  type Food,
  type Nutrients,
  type Portion,
  sumNutrition,
  updateDiaryPortion,
} from "@edo/core";
import type { DiaryMeal, DiaryStore } from "@edo/storage";

export function localDay(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function nextMidnight(date: Date): number {
  const midnight = new Date(date);
  return midnight.setHours(24, 0, 0, 0);
}

export function calendarDate(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

export function addDays(day: string, count: number): string {
  const date = calendarDate(day);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

export function mondayOf(day: string): string {
  const weekday = calendarDate(day).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
}

export function diaryDayLimit(diary: DiaryStore, today: string): string {
  try {
    const lastLoggedDay = diary.latestMealDay();
    return lastLoggedDay && lastLoggedDay > today ? lastLoggedDay : today;
  } catch {
    return today;
  }
}

export type EntryTime = { day: string; occurredAt: number; utcOffsetMinutes?: number };

export function entryTime(selectedDay: string | null, now: Date): EntryTime {
  const event = new Date(now);
  const today = localDay(now);
  const day = selectedDay && selectedDay < today ? selectedDay : today;
  if (day !== today) {
    const date = calendarDate(day);
    const selectedDate = [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()] as const;
    event.setFullYear(...selectedDate);
    if (localDay(event) !== day) {
      // A clock change can move the inherited wall time into the next calendar day.
      event.setTime(now.getTime());
      event.setHours(12, 0, 0, 0);
      event.setFullYear(...selectedDate);
      // Some time zones skipped an entire day. Keep the chosen diary day and use UTC noon.
      if (localDay(event) !== day) {
        return { day, occurredAt: date.setUTCHours(12), utcOffsetMinutes: 0 };
      }
    }
  }
  return { day, occurredAt: event.getTime(), utcOffsetMinutes: -event.getTimezoneOffset() || 0 };
}

export function showTime(
  { occurredAt, utcOffsetMinutes }: Pick<DiaryMeal, "occurredAt" | "utcOffsetMinutes">,
  locale: string,
): string {
  const hasOffset = utcOffsetMinutes !== undefined;
  // Only the clock time is displayed. Keeping it near the epoch also avoids Date overflow.
  const clockTime = hasOffset
    ? (occurredAt % (24 * 60 * 60_000)) + utcOffsetMinutes * 60_000
    : occurredAt;
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: hasOffset ? "UTC" : undefined,
  }).format(clockTime);
}

export function readAmount(text: string): number | null {
  const trimmed = text.trim();
  if (!/^(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(trimmed)) return null;
  const amount = Number(trimmed.replace(",", "."));
  return amount > 0 && amount <= Number.MAX_SAFE_INTEGER ? amount : null;
}

export function defaultFoodPortion(food: Food): Portion {
  switch (food.nutrition.basis) {
    case "per-portion":
      return { amount: 1, unit: "portion" };
    case "per-100-ml":
      return { amount: 100, unit: "ml" };
    case "per-100-g":
      return { amount: 100, unit: "g" };
  }
}

export function nutritionSum(items: readonly Nutrients[]): Nutrients | null {
  try {
    return sumNutrition(items);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

export function totalNutrition(meals: readonly DiaryMeal[]): Nutrients | null {
  return nutritionSum(meals.flatMap((meal) => meal.items.map((item) => item.nutrients)));
}

/** Keep the stored order, replacing the edited item or inserting a newly logged meal by time. */
export function foodPreviewItems(
  meals: readonly DiaryMeal[],
  entry:
    | { readonly kind: "add"; readonly occurredAt: number }
    | { readonly kind: "edit"; readonly mealId: string; readonly itemId: string },
) {
  const items: Nutrients[] = [];
  let index = -1;
  for (const meal of meals) {
    if (entry.kind === "add" && index < 0 && meal.occurredAt > entry.occurredAt) {
      index = items.length;
    }
    for (const item of meal.items) {
      if (entry.kind === "edit" && meal.id === entry.mealId && item.id === entry.itemId) {
        index = items.length;
      } else {
        items.push(item.nutrients);
      }
    }
  }
  return index < 0 && entry.kind === "edit"
    ? null
    : { items, index: index < 0 ? items.length : index };
}

export function nutritionTargetProgress(logged: number | null, target: number | null) {
  if (logged === null || target === null) return null;
  const ratio = target > 0 ? logged / target : Number(logged > 0);
  return {
    fraction: Math.min(ratio, 1),
    ratio: target > 0 && Number.isFinite(ratio) ? ratio : null,
  };
}

export type FoodEntry =
  | ({
      kind: "add";
      food: Food;
    } & EntryTime)
  | {
      kind: "edit";
      day: string;
      mealId: string;
      itemId: string;
    };

export function saveFood(
  diary: DiaryStore,
  entry: FoodEntry,
  portion: Portion,
  newId: () => string,
): void {
  if (entry.kind === "add") {
    const item = createDiaryItem(newId(), entry.food, portion);
    diary.saveMeal({
      id: newId(),
      localDay: entry.day,
      occurredAt: entry.occurredAt,
      utcOffsetMinutes: entry.utcOffsetMinutes,
      items: [item],
    });
    return;
  }

  const meal = diary.getMeal(entry.mealId);
  const item = meal?.items.find((item) => item.id === entry.itemId);
  if (!meal || !item || meal.localDay !== entry.day) throw new Error("Diary item is missing");
  if (portion.amount === item.portion.amount && portion.unit === item.portion.unit) return;
  const updated = updateDiaryPortion(item, portion);
  diary.saveMeal({
    ...meal,
    items: meal.items.map((item) => (item.id === updated.id ? updated : item)),
  });
}
