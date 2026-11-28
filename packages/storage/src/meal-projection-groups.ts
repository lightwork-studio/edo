import type { DiaryMeal } from "@edo/core";

export interface MealProjectionCandidate {
  readonly id: string;
  readonly current: DiaryMeal | null;
  /** Undefined means the diary has no evidence of a prior projection. Null is a known deletion. */
  readonly prior: DiaryMeal | null | undefined;
  /** A v5 journal may know the revision without retaining its effective local contents. */
  readonly hadPriorBase?: boolean;
  /** Positive ownership evidence may exist even when the complete prior meal is unavailable. */
  readonly priorClaims?: readonly string[];
  readonly unknownPrior?: boolean;
  /** Undefined means the account copy is opaque or unavailable. */
  readonly incoming: DiaryMeal | null | undefined;
  readonly opaqueClaims?: readonly string[];
  readonly blocked?: boolean;
}

function sameMeal(left: DiaryMeal | null, right: DiaryMeal | null | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasUnknownPrior({ unknownPrior, hadPriorBase, prior }: MealProjectionCandidate) {
  return unknownPrior ?? (hadPriorBase === true && prior === undefined);
}

function sameItemIds(current: DiaryMeal | null, prior: DiaryMeal | null) {
  const currentIds = new Set(current?.items.map(({ id }) => id));
  return (
    currentIds.size === (prior?.items.length ?? 0) &&
    (prior?.items.every(({ id }) => currentIds.has(id)) ?? true)
  );
}

function canProject(candidate: MealProjectionCandidate): boolean {
  const { current, prior, incoming, hadPriorBase, blocked } = candidate;
  if (blocked || incoming === undefined || hasUnknownPrior(candidate)) return false;
  if (prior === null && incoming !== null) return false;
  if (sameMeal(current, incoming)) {
    return prior === undefined ? !hadPriorBase : sameItemIds(current, prior);
  }
  return prior === undefined ? !hadPriorBase && current === null : sameMeal(current, prior);
}

/**
 * Group normalized, eligible meal updates that share item ownership. The caller supplies the
 * complete current owners of their incoming item IDs from the same SQLite transaction.
 */
export function groupMealProjections(
  candidates: readonly MealProjectionCandidate[],
  owners: ReadonlyMap<string, string>,
) {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  if (byId.size !== candidates.length) throw new Error("Duplicate meal projection candidates");
  const neighbors = new Map(candidates.map(({ id }) => [id, new Set<string>()]));
  const blocked = new Set(
    candidates.filter((candidate) => !canProject(candidate)).map(({ id }) => id),
  );
  const claims = new Map<string, string>();
  const priorOwners = new Map<string, Set<string>>();
  const unknownClaims = candidates.some(
    ({ incoming, opaqueClaims }) => incoming === undefined && opaqueClaims === undefined,
  );
  const unknownHistory = candidates.some(hasUnknownPrior);
  for (const { id, prior, priorClaims } of candidates) {
    for (const itemId of priorClaims ?? prior?.items.map((item) => item.id) ?? []) {
      const itemOwners = priorOwners.get(itemId) ?? new Set<string>();
      itemOwners.add(id);
      priorOwners.set(itemId, itemOwners);
    }
  }

  function link(first: string, second: string) {
    neighbors.get(first)?.add(second);
    neighbors.get(second)?.add(first);
  }

  function linkOwner(id: string, owner: string | undefined) {
    if (owner === undefined || owner === id) return;
    if (byId.has(owner)) link(id, owner);
    else blocked.add(id);
  }

  for (const { id, current, incoming, opaqueClaims } of candidates) {
    const itemIds =
      incoming === undefined ? opaqueClaims : (incoming?.items.map(({ id }) => id) ?? []);
    if (!itemIds) continue;
    if (unknownClaims || unknownHistory) {
      const currentIds = new Set(current?.items.map(({ id }) => id));
      if (itemIds.length !== currentIds.size || itemIds.some((itemId) => !currentIds.has(itemId))) {
        blocked.add(id);
      }
    }
    for (const itemId of itemIds) {
      const other = claims.get(itemId);
      if (other !== undefined && other !== id) {
        link(id, other);
        blocked.add(id);
        blocked.add(other);
      } else {
        claims.set(itemId, id);
      }
      linkOwner(id, owners.get(itemId));
      for (const priorOwner of priorOwners.get(itemId) ?? []) linkOwner(id, priorOwner);
    }
  }

  const groups: string[][] = [];
  const deferred: string[] = [];
  const visited = new Set<string>();
  for (const { id } of candidates) {
    if (visited.has(id)) continue;
    const group = [id];
    visited.add(id);
    for (const mealId of group) {
      for (const neighbor of neighbors.get(mealId) ?? []) {
        if (visited.has(neighbor)) continue;
        group.push(neighbor);
        visited.add(neighbor);
      }
    }
    if (group.some((member) => blocked.has(member))) deferred.push(...group);
    else groups.push(group);
  }
  return { groups, deferred };
}
