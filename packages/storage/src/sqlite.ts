export type SqlValue = number | string | null;
export type SqlRow = Record<string, unknown>;

/** The synchronous SQLite operations shared by the device stores. */
export interface SqliteConnection {
  exec(sql: string): void;
  run(sql: string, ...parameters: SqlValue[]): void;
  all(sql: string, ...parameters: SqlValue[]): SqlRow[];
  get(sql: string, ...parameters: SqlValue[]): SqlRow | undefined;
}

export type DiarySqliteConnection = SqliteConnection;

export function rollback(
  db: SqliteConnection,
  cause: unknown,
  failureMessage = "Diary transaction and rollback failed",
): never {
  try {
    db.exec("ROLLBACK");
  } catch (error) {
    throw new AggregateError([cause, error], failureMessage);
  }
  throw cause;
}
