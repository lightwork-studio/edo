import type { DiaryItem, DiaryMeal } from "./diary.ts";
import type { Nutrients } from "./nutrition.ts";
import { foodForRecipe, type Recipe } from "./recipe.ts";

export type DiaryMealConflict =
  | { readonly kind: "record" | "time" | "item-order" }
  | { readonly kind: "item"; readonly id: string };

export type DiaryMealReconciliation =
  | { readonly status: "merged"; readonly meal: DiaryMeal | null }
  | {
      readonly status: "conflict";
      readonly conflicts: readonly DiaryMealConflict[];
      readonly base: DiaryMeal | null;
      readonly local: DiaryMeal | null;
      readonly server: DiaryMeal | null;
    };

export type DiaryRecipeConflict =
  | {
      readonly kind:
        | "record"
        | "name"
        | "servings-and-weight"
        | "ingredient-order"
        | "invalid-recipe";
    }
  | { readonly kind: "ingredient"; readonly id: string };

export type DiaryRecipeReconciliation =
  | { readonly status: "merged"; readonly recipe: Recipe | null }
  | {
      readonly status: "conflict";
      readonly conflicts: readonly DiaryRecipeConflict[];
      readonly base: Recipe | null;
      readonly local: Recipe | null;
      readonly server: Recipe | null;
    };

type Choice<T> = { readonly value: T } | { readonly conflict: true };

function choose<T>(base: T, local: T, server: T, equal: (a: T, b: T) => boolean): Choice<T> {
  if (equal(local, server) || equal(base, server)) return { value: local };
  if (equal(base, local)) return { value: server };
  return { conflict: true };
}

function nutritionValues(values: Nutrients) {
  const { kcal, proteinG, availableCarbohydratesG, fatG, fiberG } = values;
  return [kcal, proteinG, availableCarbohydratesG, fatG, fiberG];
}

function snapshotKey(item: DiaryItem): string {
  const { food, portion, nutrients } = item;
  const { basis, portionSize, gramsPerMilliliter } = food.nutrition;
  return JSON.stringify([
    item.id,
    [portion.amount, portion.unit],
    [food.id.provider, food.id.sourceId, food.name, food.release, food.preparation],
    [basis, portionSize?.amount, portionSize?.unit, gramsPerMilliliter],
    nutritionValues(food.nutrition.nutrients),
    nutritionValues(nutrients),
  ]);
}

function sameItem(a: DiaryItem | undefined, b: DiaryItem | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && snapshotKey(a) === snapshotKey(b));
}

function sameItems(a: readonly DiaryItem[], b: readonly DiaryItem[]): boolean {
  return a.length === b.length && a.every((item, index) => sameItem(item, b[index]));
}

function sameEvent(a: DiaryMeal, b: DiaryMeal): boolean {
  return a.localDay === b.localDay && a.occurredAt === b.occurredAt;
}

function sameTime(a: DiaryMeal, b: DiaryMeal): boolean {
  return sameEvent(a, b) && a.utcOffsetMinutes === b.utcOffsetMinutes;
}

function retainKnownOffset(meal: DiaryMeal | null, known: DiaryMeal | null): DiaryMeal | null {
  if (
    meal &&
    meal.utcOffsetMinutes === undefined &&
    known?.utcOffsetMinutes !== undefined &&
    sameEvent(meal, known)
  ) {
    return { ...meal, utcOffsetMinutes: known.utcOffsetMinutes };
  }
  return meal;
}

function sameMeal(a: DiaryMeal | null, b: DiaryMeal | null): boolean {
  return a === b || (a !== null && b !== null && sameTime(a, b) && sameItems(a.items, b.items));
}

function indexedItems(items: readonly DiaryItem[]) {
  const index = new Map(items.map((item) => [item.id, item]));
  if (index.size !== items.length) throw new TypeError("Duplicate captured item IDs");
  return index;
}

function relativeOrder(index: ReadonlyMap<string, number>, a: string, b: string) {
  const first = index.get(a);
  const second = index.get(b);
  return first === undefined || second === undefined ? 0 : Math.sign(first - second);
}

function itemPositions(items: readonly DiaryItem[]): ReadonlyMap<string, number> {
  return new Map(items.map(({ id }, position) => [id, position]));
}

function placementChanged(
  base: ReadonlyMap<string, number>,
  edited: ReadonlyMap<string, number>,
  id: string,
): boolean {
  for (const otherId of base.keys()) {
    if (otherId === id || !edited.has(otherId)) continue;
    if (relativeOrder(base, id, otherId) !== relativeOrder(edited, id, otherId)) return true;
  }
  return false;
}

/** Combine each observed ordering. A cycle means the two arrangements cannot both be kept. */
function mergeOrder(
  items: ReadonlyMap<string, DiaryItem>,
  prior: ReadonlyMap<string, number>,
  here: ReadonlyMap<string, number>,
  there: ReadonlyMap<string, number>,
): DiaryItem[] | null {
  if (here.size === there.size && [...here].every(([id, position]) => there.get(id) === position)) {
    const ordered: DiaryItem[] = [];
    for (const id of here.keys()) {
      const item = items.get(id);
      if (item) ordered.push(item);
    }
    return ordered;
  }
  const ids = [...items.keys()].sort();
  const predecessors = new Map(ids.map((id) => [id, 0]));
  function compare(a: string, b: string): Choice<number> {
    const localOrder = relativeOrder(here, a, b);
    const serverOrder = relativeOrder(there, a, b);
    // A side without a new item has no order preference for it.
    return localOrder && serverOrder
      ? choose(relativeOrder(prior, a, b), localOrder, serverOrder, Object.is)
      : { value: localOrder || serverOrder };
  }
  for (const [position, a] of ids.entries()) {
    for (const b of ids.slice(position + 1)) {
      const order = compare(a, b);
      if ("conflict" in order) return null;
      if (order.value === 0) continue;
      const later = order.value < 0 ? b : a;
      predecessors.set(later, (predecessors.get(later) ?? 0) + 1);
    }
  }

  const sorted: DiaryItem[] = [];
  while (predecessors.size > 0) {
    // Map insertion order is lexical, so independent insertions have a stable order.
    const id = ids.find((candidate) => predecessors.get(candidate) === 0);
    const next = id === undefined ? undefined : items.get(id);
    if (!next) return null;
    predecessors.delete(next.id);
    // Re-evaluate outgoing edges so large meals do not require a dense graph in memory.
    for (const [waiting, count] of predecessors) {
      const order = compare(next.id, waiting);
      if ("value" in order && order.value < 0) predecessors.set(waiting, count - 1);
    }
    sorted.push(next);
  }
  return sorted;
}

function reconcileItems(
  base: readonly DiaryItem[],
  local: readonly DiaryItem[],
  server: readonly DiaryItem[],
) {
  const baseItems = indexedItems(base);
  const localItems = indexedItems(local);
  const serverItems = indexedItems(server);
  const baseOrder = itemPositions(base);
  const localOrder = itemPositions(local);
  const serverOrder = itemPositions(server);
  const ids = new Set([...baseItems.keys(), ...localItems.keys(), ...serverItems.keys()]);
  const items = new Map<string, DiaryItem>();
  const conflictingIds: string[] = [];
  for (const itemId of [...ids].sort()) {
    const before = baseItems.get(itemId);
    const here = localItems.get(itemId);
    const there = serverItems.get(itemId);
    const item = choose(before, here, there, sameItem);
    const deleteAgainstReorder =
      before &&
      ((!here && there && placementChanged(baseOrder, serverOrder, itemId)) ||
        (!there && here && placementChanged(baseOrder, localOrder, itemId)));
    if ("conflict" in item || deleteAgainstReorder) {
      conflictingIds.push(itemId);
      // Its position can still be compared when both versions retain the item.
      if (here && there) items.set(itemId, here);
    } else if (item.value) items.set(itemId, item.value);
  }
  return { items: mergeOrder(items, baseOrder, localOrder, serverOrder), conflictingIds };
}

/** Classify already decoded meals from the current domain model before any revision is applied. */
export function reconcileDiaryMeal(
  base: DiaryMeal | null,
  local: DiaryMeal | null,
  server: DiaryMeal | null,
): DiaryMealReconciliation {
  const id = base?.id ?? local?.id ?? server?.id;
  for (const meal of [base, local, server]) {
    if (meal && meal.id !== id) throw new TypeError("Diary reconciliation needs one meal ID");
    if (meal) indexedItems(meal.items);
  }
  const conflict = (conflicts: readonly DiaryMealConflict[]): DiaryMealReconciliation => ({
    status: "conflict",
    conflicts,
    base,
    local,
    server,
  });
  // Match an ordinary save: absence of an old offset does not clear a known offset for the same event.
  const localWithOffset = retainKnownOffset(retainKnownOffset(local, base), server);
  const serverWithOffset = retainKnownOffset(retainKnownOffset(server, base), local);
  const whole = choose(base, localWithOffset, serverWithOffset, sameMeal);
  if ("value" in whole) return { status: "merged", meal: whole.value };
  if (!base || !localWithOffset || !serverWithOffset) return conflict([{ kind: "record" }]);

  const { items: sorted, conflictingIds } = reconcileItems(
    base.items,
    localWithOffset.items,
    serverWithOffset.items,
  );
  const time = choose(base, localWithOffset, serverWithOffset, sameTime);
  const conflicts: DiaryMealConflict[] = [];
  if ("conflict" in time) conflicts.push({ kind: "time" });
  for (const id of conflictingIds) conflicts.push({ kind: "item", id });
  if (!sorted) conflicts.push({ kind: "item-order" });
  if ("conflict" in time || !sorted || conflicts.length > 0) return conflict(conflicts);
  const { localDay, occurredAt, utcOffsetMinutes } = time.value;
  return {
    status: "merged",
    meal: {
      id: base.id,
      localDay,
      occurredAt,
      ...(utcOffsetMinutes !== undefined && { utcOffsetMinutes }),
      items: sorted,
    },
  };
}

function sameRecipeYield(a: Recipe, b: Recipe): boolean {
  return a.servings === b.servings && a.cookedWeightG === b.cookedWeightG;
}

function sameRecipe(a: Recipe | null, b: Recipe | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.name === b.name &&
      sameRecipeYield(a, b) &&
      sameItems(a.ingredients, b.ingredients))
  );
}

/** Classify already decoded recipe edits before any revision is applied. */
export function reconcileDiaryRecipe(
  base: Recipe | null,
  local: Recipe | null,
  server: Recipe | null,
): DiaryRecipeReconciliation {
  const id = base?.id ?? local?.id ?? server?.id;
  for (const recipe of [base, local, server]) {
    if (recipe && recipe.id !== id) throw new TypeError("Diary reconciliation needs one recipe ID");
    if (recipe) indexedItems(recipe.ingredients);
  }
  const conflict = (conflicts: readonly DiaryRecipeConflict[]): DiaryRecipeReconciliation => ({
    status: "conflict",
    conflicts,
    base,
    local,
    server,
  });
  const whole = choose(base, local, server, sameRecipe);
  if ("value" in whole) return { status: "merged", recipe: whole.value };
  if (!base || !local || !server) return conflict([{ kind: "record" }]);

  const name = choose(base.name, local.name, server.name, Object.is);
  // Servings and cooked weight define a single serving's measured weight together.
  const recipeYield = choose(base, local, server, sameRecipeYield);
  const { items: ingredients, conflictingIds } = reconcileItems(
    base.ingredients,
    local.ingredients,
    server.ingredients,
  );
  const conflicts: DiaryRecipeConflict[] = [];
  if ("conflict" in name) conflicts.push({ kind: "name" });
  if ("conflict" in recipeYield) conflicts.push({ kind: "servings-and-weight" });
  for (const id of conflictingIds) conflicts.push({ kind: "ingredient", id });
  if (!ingredients) conflicts.push({ kind: "ingredient-order" });
  if ("conflict" in name || "conflict" in recipeYield || !ingredients || conflicts.length > 0) {
    return conflict(conflicts);
  }
  const { servings, cookedWeightG } = recipeYield.value;
  const recipe = {
    id: base.id,
    name: name.value,
    ingredients,
    servings,
    ...(cookedWeightG !== undefined && { cookedWeightG }),
  };
  try {
    foodForRecipe(recipe);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      return conflict([{ kind: "invalid-recipe" }]);
    }
    throw error;
  }
  return { status: "merged", recipe };
}
