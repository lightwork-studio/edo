import type { Change } from "@edo/contract";
import type { JournalSqlite } from "./journal.ts";

// Cap retained evidence per meal. Overflow is unresolved prior membership and still blocks
// decisions that need a complete list of owners.
const maxItemIds = 2048;
const maxJsonUnits = 256 * 1024;

export interface StagedMealClaims {
  readonly id: string;
  readonly itemIds: readonly string[];
  readonly unknownPrior: boolean;
}

function isItemId(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && !/[\0\ud800-\udfff]/u.test(value);
}

export function mealItemIds(content: unknown, id: string): string[] | undefined {
  if (
    !content ||
    typeof content !== "object" ||
    !("id" in content) ||
    content.id !== id ||
    !("items" in content) ||
    !Array.isArray(content.items)
  ) {
    return undefined;
  }
  const ids = new Set<string>();
  for (const item of content.items as unknown[]) {
    if (!item || typeof item !== "object" || !("id" in item) || !isItemId(item.id)) {
      return undefined;
    }
    if (ids.has(item.id)) return undefined;
    ids.add(item.id);
  }
  return [...ids];
}

function readClaims(row: Record<string, unknown>): StagedMealClaims {
  if (
    typeof row.id !== "string" ||
    typeof row.item_ids !== "string" ||
    (row.unknown_prior !== 0 && row.unknown_prior !== 1)
  ) {
    throw new Error("Invalid stored meal ownership");
  }
  const itemIds: unknown = JSON.parse(row.item_ids);
  if (
    !Array.isArray(itemIds) ||
    !itemIds.every(isItemId) ||
    new Set(itemIds).size !== itemIds.length ||
    (itemIds.length === 0 && row.unknown_prior === 0)
  ) {
    throw new Error("Invalid stored meal ownership");
  }
  return { id: row.id, itemIds, unknownPrior: row.unknown_prior === 1 };
}

export function rememberMealClaims(
  db: JournalSqlite,
  id: string,
  itemIds: readonly string[],
  unknownPrior = false,
): void {
  if (itemIds.length === 0 && !unknownPrior) return;
  const row = db.get("SELECT * FROM edo_sync_staged_meal_claims WHERE id = ?", id);
  const existing = row ? readClaims(row) : null;
  const known = new Set(existing?.itemIds);
  let storedUnits = typeof row?.item_ids === "string" ? row.item_ids.length : 2;
  unknownPrior ||= Boolean(existing?.unknownPrior);
  for (const itemId of itemIds) {
    if (!isItemId(itemId)) {
      unknownPrior = true;
      continue;
    }
    if (known.has(itemId)) continue;
    const addedUnits = JSON.stringify(itemId).length + Number(known.size > 0);
    if (known.size >= maxItemIds || storedUnits + addedUnits > maxJsonUnits) {
      unknownPrior = true;
      continue;
    }
    storedUnits += addedUnits;
    known.add(itemId);
  }
  const serialized = JSON.stringify([...known]);
  if (serialized === row?.item_ids && Number(unknownPrior) === row.unknown_prior) return;
  db.run(
    `INSERT INTO edo_sync_staged_meal_claims VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      item_ids = excluded.item_ids, unknown_prior = excluded.unknown_prior`,
    id,
    serialized,
    Number(unknownPrior),
  );
}

export function observeMealChange(db: JournalSqlite, change: Change | null): void {
  if (change?.kind !== "meal" || change.state === "deleted") return;
  const items = change.state === "live" ? mealItemIds(change.content, change.id) : undefined;
  rememberMealClaims(db, change.id, items ?? [], items === undefined);
}

export function stagedMealClaims(db: JournalSqlite): StagedMealClaims[] {
  return db.all("SELECT * FROM edo_sync_staged_meal_claims ORDER BY id").map(readClaims);
}

export function releaseMealClaims(db: JournalSqlite, id: string): void {
  db.run("DELETE FROM edo_sync_staged_meal_claims WHERE id = ?", id);
}
