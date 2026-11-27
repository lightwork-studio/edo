import type { DiaryItem, DiaryMeal } from "./diary.ts";
import type { Nutrients } from "./nutrition.ts";

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
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      sameTime(a, b) &&
      a.items.length === b.items.length &&
      a.items.every((item, index) => sameItem(item, b.items[index])))
  );
}

function indexedItems(meal: DiaryMeal) {
  const items = new Map(meal.items.map((item) => [item.id, item]));
  if (items.size !== meal.items.length) throw new TypeError("Duplicate item IDs in diary meal");
  return items;
}

function relativeOrder(index: ReadonlyMap<string, number>, a: string, b: string) {
  const first = index.get(a);
  const second = index.get(b);
  return first === undefined || second === undefined ? 0 : Math.sign(first - second);
}

function itemPositions(meal: DiaryMeal): ReadonlyMap<string, number> {
  return new Map(meal.items.map(({ id }, position) => [id, position]));
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

/** Classify already decoded meals from the current domain model before any revision is applied. */
export function reconcileDiaryMeal(
  base: DiaryMeal | null,
  local: DiaryMeal | null,
  server: DiaryMeal | null,
): DiaryMealReconciliation {
  const id = base?.id ?? local?.id ?? server?.id;
  for (const meal of [base, local, server]) {
    if (meal && meal.id !== id) throw new TypeError("Diary reconciliation needs one meal ID");
    if (meal) indexedItems(meal);
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

  const conflicts: DiaryMealConflict[] = [];
  const time = choose(base, localWithOffset, serverWithOffset, sameTime);
  const baseItems = indexedItems(base);
  const localItems = indexedItems(localWithOffset);
  const serverItems = indexedItems(serverWithOffset);
  const baseOrder = itemPositions(base);
  const localOrder = itemPositions(localWithOffset);
  const serverOrder = itemPositions(serverWithOffset);
  const ids = new Set([...baseItems.keys(), ...localItems.keys(), ...serverItems.keys()]);
  const items = new Map<string, DiaryItem>();
  if ("conflict" in time) conflicts.push({ kind: "time" });
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
      conflicts.push({ kind: "item", id: itemId });
      // Its position can still be compared when both versions retain the item.
      if (here && there) items.set(itemId, here);
    } else if (item.value) items.set(itemId, item.value);
  }
  const sorted = mergeOrder(items, baseOrder, localOrder, serverOrder);
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
