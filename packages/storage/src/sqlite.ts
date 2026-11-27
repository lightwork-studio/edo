export type SqlValue = number | string | null;
export type SqlRow = Record<string, unknown>;

/** The synchronous SQLite operations needed by the diary. */
export interface DiarySqliteConnection {
  exec(sql: string): void;
  run(sql: string, ...parameters: SqlValue[]): void;
  all(sql: string, ...parameters: SqlValue[]): SqlRow[];
  get(sql: string, ...parameters: SqlValue[]): SqlRow | undefined;
}

export function rollback(db: DiarySqliteConnection, cause: unknown): never {
  try {
    db.exec("ROLLBACK");
  } catch (error) {
    throw new AggregateError([cause, error], "Diary transaction and rollback failed");
  }
  throw cause;
}
