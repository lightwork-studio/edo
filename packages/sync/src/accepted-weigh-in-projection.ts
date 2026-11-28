import { decodeChange, type JsonObject, type Submission } from "@edo/contract";
import type { JournalSqlite } from "./journal.ts";

export function readAcceptedWeighIn(
  db: JournalSqlite,
  id: string,
  revision: number | null,
): JsonObject | null | undefined {
  if (revision === null) return undefined;
  const row = db.get(
    "SELECT content FROM edo_sync_weigh_in_projections WHERE id = ? AND revision = ?",
    id,
    revision,
  );
  if (!row) return undefined;
  if (row.content === null) return null;
  if (typeof row.content !== "string") throw new Error("Invalid stored weigh-in projection");
  const change = decodeChange({
    id,
    kind: "weigh-in",
    revision,
    state: "live",
    content: JSON.parse(row.content),
  });
  if (change.state !== "live" || change.content.id !== id) {
    throw new Error("Invalid stored weigh-in projection identity");
  }
  return change.content;
}

export function clearAcceptedWeighIn(db: JournalSqlite, id: string): void {
  db.run("DELETE FROM edo_sync_weigh_in_projections WHERE id = ?", id);
}

export function rememberAcceptedWeighIn(
  db: JournalSqlite,
  attempt: Submission,
  revision: number,
): void {
  let content: string | null = null;
  if (attempt.op === "put") {
    const { id, localDay, occurredAt, kg } = attempt.content;
    if (
      id !== attempt.id ||
      typeof localDay !== "string" ||
      typeof occurredAt !== "number" ||
      typeof kg !== "number"
    ) {
      clearAcceptedWeighIn(db, attempt.id);
      return;
    }
    content = JSON.stringify({ id, localDay, occurredAt, kg });
  }
  db.run(
    `INSERT INTO edo_sync_weigh_in_projections VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, content = excluded.content`,
    attempt.id,
    revision,
    content,
  );
}
