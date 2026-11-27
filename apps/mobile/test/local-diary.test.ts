import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import { openLocalDiary } from "../src/local-diary";

const fixture = vi.hoisted(() => ({ directory: "", incomplete: false, blockMove: false }));

vi.mock("expo-file-system", async () => {
  const { existsSync, readdirSync } = await import("node:fs");
  const { basename, dirname, join } = await import("node:path");
  const { fileURLToPath, pathToFileURL } = await import("node:url");

  class File {
    private readonly path: string;

    constructor(parent: string | { path: string }, name = "") {
      this.path = typeof parent === "string" ? fileURLToPath(parent) : join(parent.path, name);
    }

    get name() {
      return basename(this.path);
    }

    get parentDirectory() {
      const path = dirname(this.path);
      return { path, list: () => readdirSync(path).map((name) => new File({ path }, name)) };
    }

    get exists() {
      return existsSync(this.path);
    }

    get uri() {
      return pathToFileURL(this.path).href;
    }
  }

  return { File };
});

vi.mock("expo-file-system/legacy", async () => {
  const { renameSync } = await import("node:fs");
  return {
    moveAsync: async ({ from, to }: { from: string; to: string }) => {
      if (fixture.blockMove) throw new Error("Could not publish backup");
      renameSync(new URL(from), new URL(to));
    },
  };
});

vi.mock("expo-sqlite", async () => {
  const { rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { backup, DatabaseSync } = await import("node:sqlite");

  class Connection {
    readonly database: DatabaseSync;

    constructor(readonly databasePath: string) {
      this.database = new DatabaseSync(databasePath);
    }

    execSync(sql: string) {
      this.database.exec(sql);
    }

    runSync(sql: string, ...parameters: (number | string | null)[]) {
      this.database.prepare(sql).run(...parameters);
    }

    getFirstSync(sql: string, ...parameters: (number | string | null)[]) {
      return this.database.prepare(sql).get(...parameters);
    }

    getAllSync(sql: string, ...parameters: (number | string | null)[]) {
      return this.database.prepare(sql).all(...parameters);
    }

    async getFirstAsync(sql: string) {
      return this.getFirstSync(sql);
    }

    async closeAsync() {
      this.database.close();
    }
  }

  return {
    openDatabaseAsync: async (name: string) => new Connection(join(fixture.directory, name)),
    deleteDatabaseAsync: async (name: string) => {
      rmSync(join(fixture.directory, name), { force: true });
    },
    backupDatabaseAsync: async ({
      sourceDatabase,
      destDatabase,
    }: {
      sourceDatabase: Connection;
      destDatabase: Connection;
    }) => {
      if (!fixture.incomplete) await backup(sourceDatabase.database, destDatabase.databasePath);
    },
  };
});

test("serializes mobile migration opens and publishes only a verified backup", async () => {
  fixture.directory = mkdtempSync(join(tmpdir(), "edo-mobile-backup-"));
  const path = join(fixture.directory, "edo-diary.db");
  const orphan = ".edo-diary-v1-0123456789abcdef0123456789abcdef.db.partial";
  try {
    {
      using legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE diary_meals (
          id TEXT PRIMARY KEY NOT NULL,
          local_day TEXT NOT NULL,
          occurred_at INTEGER NOT NULL
        );
        CREATE INDEX diary_meals_by_day ON diary_meals (local_day, occurred_at, id);
        CREATE TABLE diary_items (
          id TEXT PRIMARY KEY NOT NULL,
          meal_id TEXT NOT NULL REFERENCES diary_meals(id) ON DELETE CASCADE,
          position INTEGER NOT NULL CHECK (position >= 0),
          snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
          UNIQUE (meal_id, position)
        );
        INSERT INTO diary_meals VALUES ('meal', '2026-11-01', 1793511000000);
        PRAGMA user_version = 1;
      `);
    }
    writeFileSync(join(fixture.directory, orphan), "interrupted backup");

    fixture.incomplete = true;
    await expect(openLocalDiary()).rejects.toThrow(/backup has the wrong storage version/);
    expect(readdirSync(fixture.directory)).toEqual(["edo-diary.db"]);

    fixture.incomplete = false;
    fixture.blockMove = true;
    await expect(openLocalDiary()).rejects.toThrow(/Could not publish backup/);
    expect(readdirSync(fixture.directory)).toEqual(["edo-diary.db"]);

    fixture.blockMove = false;
    const clients = await Promise.allSettled([openLocalDiary(), openLocalDiary()]);
    try {
      const [first, second] = clients;
      if (first?.status !== "fulfilled" || second?.status !== "fulfilled") {
        throw new Error("Expected both diary clients to open after the upgrade", {
          cause: clients,
        });
      }
      expect(first.value.diary.getMeal("meal")).toMatchObject({
        localDay: "2026-11-01",
        items: [],
      });
      first.value.diary.deleteMeal("meal");
      expect(second.value.diary.getMeal("meal")).toBeNull();
    } finally {
      await Promise.all(
        clients.flatMap((client) => (client.status === "fulfilled" ? [client.value.close()] : [])),
      );
    }
    const backups = readdirSync(fixture.directory).filter((name) => name !== "edo-diary.db");
    expect(backups).toEqual([expect.stringMatching(/^edo-diary-v1-[a-f0-9]{32}\.db$/)]);
    const backupName = backups[0];
    if (!backupName) throw new Error("Expected a verified recovery file");
    using saved = new DatabaseSync(join(fixture.directory, backupName), { readOnly: true });
    expect(saved.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(saved.prepare("SELECT id FROM diary_meals").get()).toEqual({ id: "meal" });
  } finally {
    rmSync(fixture.directory, { force: true, recursive: true });
  }
});
