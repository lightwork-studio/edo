import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openOffContributionQueue, type SqliteConnection } from "@edo/storage";
import { expect, test } from "vitest";

function connection(database: DatabaseSync): SqliteConnection {
  return {
    exec: (sql) => database.exec(sql),
    run: (sql, ...values) => {
      database.prepare(sql).run(...values);
    },
    all: (sql, ...values) => database.prepare(sql).all(...values),
    get: (sql, ...values) => database.prepare(sql).get(...values),
  };
}

const sample = {
  barcode: "00001234",
  language: "DE",
  name: "  Frühstücksflocken  ",
  brand: "Testmarke",
  packageQuantity: "500 g",
};

test("persists exactly the reviewed product and deduplicates the original printed barcode", () => {
  const directory = mkdtempSync(join(tmpdir(), "edo-off-queue-"));
  try {
    const filename = join(directory, "contributions.sqlite");
    const expected = { ...sample, language: "de", name: "Frühstücksflocken" };
    {
      using database = new DatabaseSync(filename);
      const queue = openOffContributionQueue(connection(database));
      const draft = { ...sample, diaryMeal: "private example", userNote: "private note" };
      const reviewed = queue.preview(draft);
      expect(reviewed).toEqual(expected);
      expect(Reflect.set(reviewed, "name", "a different product")).toBe(false);
      expect(() => queue.enqueue({ ...reviewed }, 1)).toThrow(/Preview the product/);
      expect(queue.pending()).toEqual([]);
      expect(queue.enqueue(reviewed, 2)).toEqual({
        status: "queued",
        entry: { product: expected, queuedAt: 2 },
      });
    }
    using database = new DatabaseSync(filename);
    const reopened = openOffContributionQueue(connection(database));
    expect(reopened.pending()).toEqual([{ product: expected, queuedAt: 2 }]);
    expect(reopened.enqueue(reopened.preview(sample), 3)).toEqual({
      status: "already-queued",
      entry: { product: expected, queuedAt: 2 },
    });
    expect(reopened.enqueue(reopened.preview({ ...sample, name: "Different" }), 4)).toEqual({
      status: "different-draft",
      entry: { product: expected, queuedAt: 2 },
    });
    expect(
      reopened.enqueue(reopened.preview({ ...sample, barcode: "0000000001234" }), 5).status,
    ).toBe("queued");
    expect(reopened.pending().map(({ product }) => product.barcode)).toEqual([
      "00001234",
      "0000000001234",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects other database files and leaves a failed enqueue retryable", () => {
  using unrelated = new DatabaseSync(":memory:");
  unrelated.exec("CREATE TABLE diary_meals (id TEXT PRIMARY KEY)");
  expect(() => openOffContributionQueue(connection(unrelated))).toThrow(/Unsupported/);
  expect(unrelated.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });

  using database = new DatabaseSync(":memory:");
  const queue = openOffContributionQueue(connection(database));
  expect(() => queue.preview({ ...sample, barcode: "0000" })).toThrow(/barcode/);
  expect(() => queue.preview({ ...sample, language: "de-DE" })).toThrow(/language/);
  expect(() => queue.preview({ ...sample, name: "" })).toThrow(/name/);
  const reviewed = queue.preview(sample);
  database.exec(`
    CREATE TRIGGER fail_queue BEFORE INSERT ON off_contributions
    BEGIN SELECT RAISE(ABORT, 'offline queue write interrupted'); END
  `);
  expect(() => queue.enqueue(reviewed, 6)).toThrow(/write interrupted/);
  expect(queue.pending()).toEqual([]);
  database.exec("DROP TRIGGER fail_queue");
  expect(queue.enqueue(reviewed, 6).status).toBe("queued");
  database.exec("PRAGMA user_version = 2");
  expect(() => queue.enqueue(reviewed, 7)).toThrow(/Unsupported/);
  expect(() => queue.pending()).toThrow(/Unsupported/);
  expect(database.prepare("SELECT queued_at FROM off_contributions").get()).toEqual({
    queued_at: 6,
  });
});

test("keeps writes in the main queue and refuses a missing table even with other schemas attached", () => {
  using database = new DatabaseSync(":memory:");
  const queue = openOffContributionQueue(connection(database));
  database.exec(`
    CREATE TEMP TABLE off_contributions AS SELECT * FROM main.off_contributions WHERE 0;
    ATTACH DATABASE ':memory:' AS other;
    CREATE TABLE other.off_contributions AS SELECT * FROM main.off_contributions WHERE 0;
  `);
  const reviewed = queue.preview(sample);
  expect(queue.enqueue(reviewed, 2)).toMatchObject({ status: "queued" });
  expect(database.prepare("SELECT count(*) AS count FROM temp.off_contributions").get()).toEqual({
    count: 0,
  });
  expect(queue.pending()).toEqual([{ product: reviewed, queuedAt: 2 }]);
  expect(openOffContributionQueue(connection(database)).pending()).toEqual(queue.pending());

  database.exec("DROP TABLE main.off_contributions");
  expect(() => queue.enqueue(reviewed, 3)).toThrow(/Missing Open Food Facts/);
  expect(() => queue.pending()).toThrow(/Missing Open Food Facts/);
  expect(() => openOffContributionQueue(connection(database))).toThrow(/Missing Open Food Facts/);
  expect(database.prepare("SELECT count(*) AS count FROM temp.off_contributions").get()).toEqual({
    count: 0,
  });
  expect(database.prepare("SELECT count(*) AS count FROM other.off_contributions").get()).toEqual({
    count: 0,
  });
});
