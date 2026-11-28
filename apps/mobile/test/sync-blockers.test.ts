import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDiaryItem } from "@edo/core";
import { openDiary, type SqliteConnection } from "@edo/storage";
import { expect, it } from "vitest";
import {
  readSyncBlocker,
  reviewItemPage,
  reviewQuantityFormatter,
  syncBlockerNotice,
} from "../src/sync-blockers";

it("bounds each captured meal page and reaches a partial final page without repeating items", () => {
  const items = Array.from({ length: 61 }, (_, index) => ({ id: `item-${index + 1}` }));
  const pages = [0, 1, 2, 3].map((page) => reviewItemPage(items, page));
  expect(pages.map(({ start, end }) => [start, end])).toEqual([
    [0, 20],
    [20, 40],
    [40, 60],
    [60, 61],
  ]);
  expect(pages.map(({ items }) => items.length)).toEqual([20, 20, 20, 1]);
  expect(pages.flatMap(({ items }) => items)).toEqual(items);
  expect(reviewItemPage([], 0)).toEqual({ items: [], total: 0, start: 0, end: 0 });
});

it("keeps weight precision when the locale uses a different decimal separator or numeral glyph", () => {
  const german = reviewQuantityFormatter("de-DE");
  expect(german(80.0021)).toBe("80,0021");
  expect(german(80.0022)).toBe("80,0022");
  expect(reviewQuantityFormatter("de-CH")(80.0021)).toBe("80.0021");
  expect(reviewQuantityFormatter("en-US-u-nu-mathbold")(80.0021)).toBe("80.0021");
});

function connectionFor(db: DatabaseSync): SqliteConnection {
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, ...parameters) => void db.prepare(sql).run(...parameters),
    get: (sql, ...parameters) => db.prepare(sql).get(...parameters),
    all: (sql, ...parameters) => db.prepare(sql).all(...parameters),
  };
}

function open(db: DatabaseSync) {
  return openDiary({
    connection: connectionFor(db),
    async backupBeforeMigration() {
      throw new Error("The test diary is blank or current");
    },
  });
}

it("finds persisted record blockers offline and exposes only their presentation fields", async () => {
  const temp = mkdtempSync(join(tmpdir(), "edo-mobile-sync-blockers-"));
  const path = join(temp, "diary.sqlite");
  const meal = { kind: "meal", id: "fixture-meal" };
  const weight = { kind: "weigh-in", id: "fixture-weight" };
  const privateText = { name: "Private test content" };
  try {
    {
      using db = new DatabaseSync(path);
      const diary = await open(db);
      expect(syncBlockerNotice(diary.sync.journal)).toBe("clear");
      db.exec(`INSERT INTO edo_sync_binding
        VALUES (1, 'https://example.test', 'account', 'lineage', 2, 1)`);
      const insert = db.prepare("INSERT INTO edo_sync_outbox VALUES (?, ?, NULL, NULL, ?)");
      for (const key of [meal, weight]) {
        const submissionId = `old-${key.id}`;
        const isMeal = key === meal;
        const record = {
          key,
          baseRevision: null,
          base: null,
          pending: isMeal ? { op: "delete", submissionId: "new-meal-edit" } : null,
          attempt: null,
          blocked: {
            submission: {
              ...key,
              baseRevision: null,
              submissionId,
              op: "put",
              content: privateText,
            },
            result: isMeal
              ? {
                  submissionId,
                  status: "conflict",
                  reason: "exists",
                  current: { ...key, state: "live", revision: 1, content: privateText },
                }
              : {
                  submissionId,
                  status: "rejected",
                  code: "invalid-content",
                  message: "Account response detail",
                },
          },
        };
        insert.run(key.kind, key.id, JSON.stringify(record));
      }
    }

    using reopened = new DatabaseSync(path);
    const diary = await open(reopened);
    const { journal } = diary.sync;
    const rawBefore = reopened
      .prepare("SELECT content FROM edo_sync_outbox ORDER BY kind, id")
      .all();
    expect(syncBlockerNotice(journal)).toBe("blocked");
    const first = readSyncBlocker(journal, null);
    expect(first).toEqual({
      state: "blocked",
      kind: "meal",
      reason: "exists",
      operation: "delete",
      next: meal,
      meal: {
        phone: { state: "deleted" },
        account: { state: "unavailable" },
      },
    });
    if (first.state !== "blocked") throw new Error("Expected the first blocker");
    expect(readSyncBlocker(journal, first.next)).toEqual({
      state: "blocked",
      kind: "weigh-in",
      reason: "invalid-content",
      operation: "put",
      next: null,
      weighIn: { phone: { state: "unavailable" }, account: { state: "unknown" } },
    });
    expect(reopened.prepare("SELECT content FROM edo_sync_outbox ORDER BY kind, id").all()).toEqual(
      rawBefore,
    );
    expect(readSyncBlocker({ ...journal, blockedReview: () => null }, null)).toEqual({
      state: "changed",
      next: meal,
    });
    reopened.exec(`UPDATE edo_sync_outbox SET
      content = json_set(content, '$.blocked.submission.op', 'invalid') WHERE kind = 'meal'`);
    const unreadable = readSyncBlocker(journal, null);
    expect(unreadable).toEqual({ state: "error", next: meal });
    expect(readSyncBlocker(journal, unreadable.next)).toMatchObject({
      state: "blocked",
      kind: "weigh-in",
    });
    reopened.exec(`UPDATE edo_sync_outbox SET content =
      json_set(content, '$.blocked.submission.op', 'put', '$.blocked.result.status', 'damaged')
      WHERE kind = 'meal'`);
    expect(() => journal.blockedRecords(null, 1)).toThrow(/Invalid blocked sync record/);
    expect(syncBlockerNotice(journal)).toBe("blocked");
    const malformedStatus = readSyncBlocker(journal, null);
    expect(malformedStatus).toEqual({ state: "error", next: meal });
    expect(readSyncBlocker(journal, malformedStatus.next)).toMatchObject({
      state: "blocked",
      kind: "weigh-in",
    });

    // An invalid receipt can also defeat an adapter's integer conversion before validation.
    reopened.exec(`UPDATE edo_sync_outbox SET content =
      json_set(content, '$.blocked.result.status', 9007199254740992) WHERE kind = 'meal'`);
    expect(readSyncBlocker(journal, null)).toEqual({ state: "error", next: meal });
    expect(readSyncBlocker(journal, meal)).toMatchObject({ state: "blocked", kind: "weigh-in" });

    // The marker itself can be damaged while the row still passes the JSON constraint.
    reopened.exec(`UPDATE edo_sync_outbox SET content =
      json_set(content, '$.blocked', 'damaged') WHERE kind = 'meal'`);
    expect(journal.blockedRecords(null, 1).records.map(({ key }) => key)).toEqual([weight]);
    expect(syncBlockerNotice(journal)).toBe("blocked");
    expect(readSyncBlocker(journal, null)).toEqual({ state: "error", next: meal });
    expect(readSyncBlocker(journal, meal)).toMatchObject({ state: "blocked", kind: "weigh-in" });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("shows the latest phone change and account weigh-in without opaque or identity fields", async () => {
  using db = new DatabaseSync(":memory:");
  const {
    sync: { journal },
  } = await open(db);
  const key = { kind: "weigh-in", id: "reviewed-weight" };
  const captured = {
    id: key.id,
    kg: 80.002,
    localDay: "2026-11-10",
    occurredAt: Date.parse("2026-11-11T00:30:00.003Z"),
  };
  const { id: _id, ...visible } = captured;
  const submitted = { ...captured, kg: 79 };
  const received = { ...key, state: "live", revision: 2, content: { ...captured, kg: 81 } };
  const pulled = {
    ...received,
    revision: 3,
    content: { ...captured, kg: 81.003, future: "opaque fixture field" },
  };
  db.exec(`INSERT INTO edo_sync_binding
    VALUES (1, 'https://example.test', 'account', 'lineage', 3, 3)`);
  db.prepare("INSERT INTO edo_sync_outbox VALUES (?, ?, NULL, NULL, ?)").run(
    key.kind,
    key.id,
    JSON.stringify({
      key,
      baseRevision: 1,
      base: null,
      pending: { op: "put", submissionId: "latest", content: { ...captured, private: "fixture" } },
      attempt: null,
      blocked: {
        submission: {
          ...key,
          baseRevision: 1,
          submissionId: "prior",
          op: "put",
          content: submitted,
        },
        result: { submissionId: "prior", status: "conflict", reason: "stale", current: received },
      },
    }),
  );
  db.prepare("INSERT INTO edo_sync_remote VALUES (?, ?, ?, ?)").run(
    key.kind,
    key.id,
    pulled.revision,
    JSON.stringify(pulled),
  );
  const review = readSyncBlocker(journal, null);
  if (review.state !== "blocked") throw new Error("Expected a tracked weigh-in conflict");
  expect(review.weighIn).toEqual({
    phone: { state: "live", ...visible },
    account: { state: "live", ...visible, kg: 81.003 },
  });

  const setAccount = db.prepare("UPDATE edo_sync_remote SET revision = ?, content = ?");
  setAccount.run(2, JSON.stringify({ ...received, content: { ...captured, kg: 83 } }));
  expect(readSyncBlocker(journal, null)).toMatchObject({
    weighIn: { account: { state: "unavailable" } },
  });
  const setReceipt = db.prepare(
    "UPDATE edo_sync_outbox SET content = json_set(content, '$.blocked.result.current', json(?))",
  );
  setReceipt.run(JSON.stringify({ ...key, revision: 2, state: "unavailable" }));
  expect(readSyncBlocker(journal, null)).toMatchObject({
    weighIn: { account: { state: "live", ...visible, kg: 83 } },
  });
  setAccount.run(2, JSON.stringify({ ...key, revision: 2, state: "deleted" }));
  expect(readSyncBlocker(journal, null)).toMatchObject({
    weighIn: { account: { state: "unavailable" } },
  });
  setReceipt.run(JSON.stringify({ ...received, content: { ...captured, kg: 82 } }));
  setAccount.run(2, JSON.stringify({ ...key, revision: 2, state: "unavailable" }));
  expect(readSyncBlocker(journal, null)).toMatchObject({
    weighIn: { account: { state: "live", ...visible, kg: 82 } },
  });
  setReceipt.run(JSON.stringify({ ...key, revision: 2, state: "deleted" }));
  setAccount.run(3, JSON.stringify({ ...received, revision: 3 }));
  expect(readSyncBlocker(journal, null)).toMatchObject({
    weighIn: { account: { state: "unavailable" } },
  });
  setAccount.run(4, JSON.stringify({ ...key, revision: 4, state: "deleted" }));
  expect(readSyncBlocker(journal, null)).toMatchObject({
    weighIn: { account: { state: "deleted" } },
  });
  db.exec(`UPDATE edo_sync_outbox SET content =
    json_set(content, '$.pending.content.localDay', '2026-02-29')`);
  expect(readSyncBlocker(journal, null)).toMatchObject({
    weighIn: { phone: { state: "unavailable" } },
  });
});

it("compares captured meals without exposing opaque fields or changing the saved journal", async () => {
  using db = new DatabaseSync(":memory:");
  const {
    sync: { journal },
  } = await open(db);
  const key = { kind: "meal", id: "reviewed-meal" };
  const day = { localDay: "2026-11-05", occurredAt: 1793910600003, utcOffsetMinutes: -240 };
  const food = {
    id: { provider: "bls", sourceId: "local-fixture" },
    name: "Captured oats",
    release: "BLS fixture",
    preparation: "raw",
    nutrition: {
      basis: "per-100-g",
      nutrients: { kcal: 100, proteinG: 2, availableCarbohydratesG: 18, fatG: 1, fiberG: 2 },
    },
  } as const;
  const large = createDiaryItem("stable-item", food, { amount: 75, unit: "g" });
  const small = createDiaryItem("stable-item", food, { amount: 50, unit: "g" });
  // Preserve the stored nutrient values even if a newer catalog would recalculate the amount.
  const phoneItem = { ...large, nutrients: { ...large.nutrients, kcal: 76.125 } };
  const accountItem = { ...small, nutrients: { ...small.nutrients, kcal: null, proteinG: 2.125 } };
  const phone = { id: key.id, ...day, items: [{ ...phoneItem, future: "opaque-item" }] };
  const account = {
    ...key,
    revision: 2,
    state: "live",
    content: { id: key.id, ...day, items: [accountItem], future: "opaque-meal" },
  };
  db.exec(`INSERT INTO edo_sync_binding
    VALUES (1, 'https://example.test', 'account', 'lineage', 2, 2)`);
  db.prepare("INSERT INTO edo_sync_outbox VALUES (?, ?, NULL, NULL, ?)").run(
    key.kind,
    key.id,
    JSON.stringify({
      key,
      baseRevision: 1,
      base: null,
      pending: { op: "put", submissionId: "latest", content: phone },
      attempt: null,
      blocked: {
        submission: { ...key, op: "put", baseRevision: 1, submissionId: "prior", content: phone },
        result: {
          submissionId: "prior",
          status: "conflict",
          reason: "stale",
          current: { ...key, revision: 2, state: "unavailable" },
        },
      },
    }),
  );
  db.prepare("INSERT INTO edo_sync_remote VALUES (?, ?, ?, ?)").run(
    key.kind,
    key.id,
    account.revision,
    JSON.stringify(account),
  );
  const saved = db.prepare("SELECT content FROM edo_sync_outbox").get();
  db.exec("PRAGMA query_only = ON");
  const review = readSyncBlocker(journal, null);
  if (review.state !== "blocked") throw new Error("Expected a tracked meal conflict");
  expect(review.meal).toEqual({
    phone: { state: "live", meal: { ...day, items: [phoneItem] } },
    account: { state: "live", meal: { ...day, items: [accountItem] } },
  });
  expect(db.prepare("SELECT content FROM edo_sync_outbox").get()).toEqual(saved);
  db.exec("PRAGMA query_only = OFF");

  const setAccount = db.prepare("UPDATE edo_sync_remote SET revision = ?, content = ?");
  const malformed = {
    ...account,
    content: { ...account.content, items: [accountItem, accountItem] },
  };
  setAccount.run(2, JSON.stringify(malformed));
  expect(readSyncBlocker(journal, null)).toMatchObject({
    meal: { account: { state: "unavailable" } },
  });
  setAccount.run(3, JSON.stringify({ ...key, revision: 3, state: "deleted" }));
  expect(readSyncBlocker(journal, null)).toMatchObject({
    meal: { account: { state: "deleted" } },
  });
});

it("shows a recoverable status when reading the journal fails", async () => {
  using db = new DatabaseSync(":memory:");
  const diary = await open(db);
  const { journal } = diary.sync;
  expect(readSyncBlocker(journal, null)).toEqual({ state: "empty", next: null });
  db.exec(`INSERT INTO edo_sync_binding
    VALUES (1, 'https://example.test', 'account', 'lineage', 2, 1);
    ALTER TABLE edo_sync_outbox RENAME TO unreadable_test_outbox`);
  expect(syncBlockerNotice(journal)).toBe("error");
  expect(readSyncBlocker(journal, null)).toEqual({ state: "error", next: null });
});

it("reviews captured recipe yields and ingredients without changing the saved conflict", async () => {
  using db = new DatabaseSync(":memory:");
  const {
    sync: { journal },
  } = await open(db);
  const key = { kind: "recipe", id: "captured-recipe" };
  const food = {
    id: { provider: "bls", sourceId: "fixture-oats" },
    name: "Captured oats",
    release: "recipe-fixture",
    preparation: "raw",
    nutrition: {
      basis: "per-100-g",
      nutrients: { kcal: 100, proteinG: 0, availableCarbohydratesG: null, fatG: 1, fiberG: 2 },
    },
  } as const;
  const phoneItem = createDiaryItem("recipe-item-1", food, { amount: 123.125, unit: "g" });
  const accountItem = createDiaryItem("recipe-item-1", food, { amount: 89.25, unit: "g" });
  const phoneIngredients = [{ ...phoneItem, nutrients: { ...phoneItem.nutrients, kcal: 128.125 } }];
  const accountIngredients = [
    { ...accountItem, nutrients: { ...accountItem.nutrients, kcal: null } },
  ];
  const phone = {
    id: key.id,
    name: "Phone oats",
    servings: 2.125,
    cookedWeightG: 458.002,
    ingredients: phoneIngredients.map((item) => ({ ...item, future: "opaque phone ingredient" })),
    future: "opaque phone recipe",
  };
  const account = {
    ...key,
    revision: 2,
    state: "live",
    content: {
      id: key.id,
      name: "Account oats",
      servings: 1.875,
      ingredients: accountIngredients.map((item) => ({
        ...item,
        future: "opaque account ingredient",
      })),
      future: "opaque account recipe",
    },
  };
  db.exec(`INSERT INTO edo_sync_binding
    VALUES (1, 'https://example.test', 'fixture-account', 'fixture-lineage', 2, 2)`);
  const blocked = {
    key,
    baseRevision: 1,
    base: null,
    pending: { op: "put", submissionId: "latest", content: phone },
    attempt: null,
    blocked: {
      submission: {
        ...key,
        baseRevision: 1,
        submissionId: "older",
        op: "put",
        content: { ...phone, name: "Older phone name" },
      },
      result: {
        submissionId: "older",
        status: "conflict",
        reason: "stale",
        current: { ...key, revision: 2, state: "unavailable" },
      },
    },
  };
  db.prepare("INSERT INTO edo_sync_outbox VALUES (?, ?, NULL, NULL, ?)").run(
    key.kind,
    key.id,
    JSON.stringify(blocked),
  );
  db.prepare("INSERT INTO edo_sync_remote VALUES (?, ?, ?, ?)").run(
    key.kind,
    key.id,
    account.revision,
    JSON.stringify(account),
  );

  const before = db.prepare("SELECT content FROM edo_sync_outbox").get();
  db.exec("PRAGMA query_only = ON");
  const review = readSyncBlocker(journal, null);
  expect(review).toMatchObject({ state: "blocked", kind: "recipe" });
  if (review.state !== "blocked") throw new Error("Expected a recipe conflict");
  expect(review.recipe).toEqual({
    phone: {
      state: "live",
      recipe: {
        name: "Phone oats",
        servings: 2.125,
        cookedWeightG: 458.002,
        ingredients: phoneIngredients,
      },
    },
    account: {
      state: "live",
      recipe: { name: "Account oats", servings: 1.875, ingredients: accountIngredients },
    },
  });
  expect(db.prepare("SELECT content FROM edo_sync_outbox").get()).toEqual(before);
  db.exec("PRAGMA query_only = OFF");

  const replace = db.prepare("UPDATE edo_sync_remote SET revision = ?, content = ?");
  const impossibleYield = { ...account, content: { ...account.content, cookedWeightG: -1 } };
  replace.run(2, JSON.stringify(impossibleYield));
  expect(readSyncBlocker(journal, null)).toMatchObject({
    recipe: { account: { state: "unavailable" } },
  });
  replace.run(3, JSON.stringify({ ...key, revision: 3, state: "deleted" }));
  expect(readSyncBlocker(journal, null)).toMatchObject({
    recipe: { account: { state: "deleted" } },
  });
});
