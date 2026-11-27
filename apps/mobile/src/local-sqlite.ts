import type { SqliteConnection } from "@edo/storage";
import type { SQLiteDatabase } from "expo-sqlite";

export function connectionFor(db: SQLiteDatabase): SqliteConnection {
  return {
    exec: (sql) => db.execSync(sql),
    run: (sql, ...parameters) => {
      db.runSync(sql, ...parameters);
    },
    all: (sql, ...parameters) => db.getAllSync(sql, ...parameters),
    get: (sql, ...parameters) => db.getFirstSync(sql, ...parameters) ?? undefined,
  };
}
