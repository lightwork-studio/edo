import type { DiarySqliteConnection, SqlRow, SqlValue } from "./sqlite.ts";

// Stay below SQLite's traditional 999-binding limit for each statement.
const maxBindings = 900;

export function* archiveBatches<T>(rows: readonly T[], size: number): Generator<readonly T[]> {
  for (let offset = 0; offset < rows.length; offset += size) {
    yield rows.slice(offset, offset + size);
  }
}

export function archivePlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export function selectArchiveMatches(
  db: DiarySqliteConnection,
  select: string,
  columns: string,
  keys: readonly SqlValue[][],
  order = "",
): SqlRow[] {
  const first = keys[0];
  if (!first) return [];
  const tuple = `(${archivePlaceholders(first.length)})`;
  const rows: SqlRow[] = [];
  for (const batch of archiveBatches(keys, Math.floor(maxBindings / first.length))) {
    const matches = db.all(
      `${select} WHERE ${columns} IN (VALUES ${batch.map(() => tuple).join(", ")}) ${order}`,
      ...batch.flat(),
    );
    for (const row of matches) rows.push(row);
  }
  return rows;
}

/** The caller has validated the records and owns the restore transaction. */
export function insertArchiveRows(
  db: DiarySqliteConnection,
  insert: string,
  rows: readonly SqlValue[][],
): void {
  const first = rows[0];
  if (!first) return;
  const tuple = `(${archivePlaceholders(first.length)})`;
  for (const batch of archiveBatches(rows, Math.floor(maxBindings / first.length))) {
    db.run(`${insert} VALUES ${batch.map(() => tuple).join(", ")}`, ...batch.flat());
  }
}
