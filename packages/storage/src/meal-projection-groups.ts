import type { DiaryMeal } from "@edo/core";

interface MealProjectionCandidate {
  readonly id: string;
  readonly current: DiaryMeal | null;
  /** Undefined means the diary has no evidence of a prior projection. Null is a known deletion. */
  readonly prior: DiaryMeal | null | undefined;
  readonly incoming: DiaryMeal | null;
}

function sameMeal(left: DiaryMeal | null, right: DiaryMeal | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canProject({ current, prior, incoming }: MealProjectionCandidate): boolean {
  if (prior === null && incoming !== null) return false;
  if (sameMeal(current, incoming)) return true;
  return prior === undefined ? current === null : sameMeal(current, prior);
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

  function link(first: string, second: string) {
    neighbors.get(first)?.add(second);
    neighbors.get(second)?.add(first);
  }

  for (const { id, incoming } of candidates) {
    for (const item of incoming?.items ?? []) {
      const other = claims.get(item.id);
      if (other !== undefined && other !== id) {
        link(id, other);
        blocked.add(id);
        blocked.add(other);
      } else {
        claims.set(item.id, id);
      }
      const owner = owners.get(item.id);
      if (owner === undefined || owner === id) continue;
      if (byId.has(owner)) link(id, owner);
      else blocked.add(id);
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
