import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { decodeChange, decodeSubmission } from "@edo/contract";
import {
  createDiaryItem,
  type Food,
  foodForRecipe,
  manualNutritionTarget,
  updateDiaryPortion,
} from "@edo/core";
import {
  type DiaryMeal,
  type DiarySqliteConnection,
  mealFromTemplate,
  type NutritionTargetRecord,
  type OpenDiaryOptions,
  openDiary,
} from "@edo/storage";
import { createSyncClient } from "@edo/sync";
import { afterEach, beforeEach, expect, test } from "vitest";
import { applyRecordContent } from "../../../apps/sync-node/src/record-projection.ts";
import { createHealthServer } from "../../../apps/sync-node/src/server.ts";
import { openSyncStore } from "../../../apps/sync-node/src/sync-store.ts";
import { diaryMigrations, migrateDiary } from "../src/migrations.ts";
import { decodeSnapshot } from "../src/snapshot.ts";

const currentVersion = diaryMigrations.length;
let directory: string;
const databases: DatabaseSync[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "edo-diary-test-"));
});

afterEach(() => {
  for (const db of databases.splice(0)) {
    if (db.isOpen) db.close();
  }
  rmSync(directory, { recursive: true, force: true });
});

function connectionFor(db: DatabaseSync): DiarySqliteConnection {
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, ...parameters) => {
      db.prepare(sql).run(...parameters);
    },
    all: (sql, ...parameters) => db.prepare(sql).all(...parameters),
    get: (sql, ...parameters) => db.prepare(sql).get(...parameters),
  };
}

function createDatabase(name = "diary.db") {
  const path = join(directory, name);
  const db = new DatabaseSync(path);
  databases.push(db);
  const snapshots: string[] = [];
  const backupBeforeMigration: OpenDiaryOptions["backupBeforeMigration"] = async (
    version,
    verify,
  ) => {
    const source = new DatabaseSync(path, { readOnly: true });
    const destination = join(mkdtempSync(join(directory, "snapshot-")), `v${version}.db`);
    try {
      await backup(source, destination);
      const snapshot = new DatabaseSync(destination, { readOnly: true });
      try {
        verify(connectionFor(snapshot));
        snapshots.push(destination);
      } finally {
        snapshot.close();
      }
    } finally {
      source.close();
    }
  };
  const options: OpenDiaryOptions = {
    connection: connectionFor(db),
    backupBeforeMigration,
  };
  return { db, options, snapshots, start: () => openDiary(options) };
}

const sourceFood: Food = {
  id: { provider: "open-food-facts", sourceId: "00012345" },
  release: "fixture-a",
  name: "Soy drink",
  preparation: "as-sold",
  nutrition: {
    basis: "per-100-ml",
    nutrients: { kcal: 80, proteinG: 7, availableCarbohydratesG: 0, fatG: 3, fiberG: null },
    portionSize: { amount: 200, unit: "ml" },
    gramsPerMilliliter: 1.02,
  },
};

const meal: DiaryMeal = {
  id: "meal-night",
  localDay: "2026-10-31",
  occurredAt: Date.parse("2026-11-01T02:30:00Z"),
  items: [createDiaryItem("item-drink", sourceFood, { amount: 0.5, unit: "portion" })],
};

const weighIn = {
  id: "weigh-in",
  localDay: "2026-10-31",
  occurredAt: Date.parse("2026-11-01T02:30:00Z"),
  kg: 80,
};

const target: NutritionTargetRecord = {
  id: "target-one",
  effectiveDay: "2026-10-31",
  configuredAt: meal.occurredAt,
  mode: "manual",
  target: { kcal: 2000, proteinG: 110, fatG: 60, availableCarbohydratesG: 255 },
};

const revisedTarget: NutritionTargetRecord = {
  ...target,
  id: "target-two",
  configuredAt: target.configuredAt - 3_600_000,
  target: { ...target.target, kcal: 2100, availableCarbohydratesG: 280 },
};

function diarySyncClient(respond?: (path: string) => Response, revision = 0) {
  return createSyncClient({
    origin: "https://example.test",
    releases: [
      { release: "0.1", features: ["write-records"], writableKinds: ["meal", "weigh-in"] },
    ],
    authorization: () => "Bearer synthetic",
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path !== "/sync/hello" && respond) return respond(path);
      return Response.json({
        accountBinding: "account",
        lineage: "fixture",
        revision,
        restoredFrom: null,
        release: "0.1",
        features: ["write-records"],
      });
    },
  });
}

function diarySyncSession() {
  return diarySyncClient().connect();
}

test("queues the actual persisted meal and preserves an in-flight edit over a restart", async () => {
  const source = createDatabase();
  const diary = await source.start();
  const captured = { ...meal, utcOffsetMinutes: -240 };
  diary.saveMeal(captured);
  expect(diary.sync.journal.queued()).toEqual([]);
  expect(() => diary.sync.saveMeal(meal, "unbound")).toThrow(/Connect this diary/);
  expect(diary.getMeal(meal.id)).toEqual(captured);

  const session = await diarySyncSession();
  diary.sync.journal.bind(session);
  diary.sync.saveMeal(meal, "first-edit");
  const [first] = diary.sync.journal.prepare(session);
  if (first?.op !== "put") throw new Error("Expected a meal submission");
  expect(first.content).toEqual(captured);
  expect(
    applyRecordContent({
      key: first,
      release: session.release,
      current: null,
      submitted: first.content,
    }),
  ).toEqual(captured);

  const item = meal.items[0];
  if (!item) throw new Error("Expected a fixture item");
  const edited = { ...captured, items: [updateDiaryPortion(item, { amount: 150, unit: "ml" })] };
  diary.sync.saveMeal(edited, "newer-edit");
  source.db.close();
  const persisted = await createDatabase().start();
  expect(persisted.getMeal(meal.id)).toEqual(edited);
  persisted.sync.journal.bind(session);
  expect(persisted.sync.journal.prepare(session)).toEqual([first]);
  expect(persisted.sync.journal.queued()).toMatchObject([
    {
      attempt: first,
      pending: {
        submissionId: "newer-edit",
        content: edited,
      },
    },
  ]);
});

test("rolls back a sync meal deletion and its submission reservation if the journal write fails", async () => {
  const source = createDatabase();
  const diary = await source.start();
  diary.saveMeal(meal);
  const session = await diarySyncSession();
  diary.sync.journal.bind(session);
  source.db.exec(`PRAGMA user_version = ${currentVersion + 1}`);
  expect(() => diary.sync.deleteMeal(meal.id, "retry-delete")).toThrow(
    /storage version has changed/,
  );
  expect(() => diary.sync.journal.bind(session)).toThrow(/storage version has changed/);
  source.db.exec(`PRAGMA user_version = ${currentVersion}`);
  source.db.exec(`CREATE TRIGGER deny_outbox BEFORE INSERT ON edo_sync_outbox
    BEGIN SELECT RAISE(ABORT, 'journal unavailable'); END`);
  expect(() => diary.sync.deleteMeal(meal.id, "retry-delete")).toThrow(/journal unavailable/);
  expect(diary.getMeal(meal.id)).toEqual(meal);
  expect(diary.sync.journal.queued()).toEqual([]);
  source.db.exec("DROP TRIGGER deny_outbox");
  diary.sync.deleteMeal(meal.id, "retry-delete");
  expect(diary.getMeal(meal.id)).toBeNull();
  expect(diary.sync.journal.prepare(session)).toEqual([
    { kind: "meal", id: meal.id, submissionId: "retry-delete", baseRevision: null, op: "delete" },
  ]);
  source.db.close();
  const reopened = await createDatabase().start();
  expect(reopened.getMeal(meal.id)).toBeNull();
  expect(reopened.sync.journal.queued()[0]?.attempt?.submissionId).toBe("retry-delete");
});

const rebaseMeal = {
  ...meal,
  utcOffsetMinutes: -240,
  items: [
    createDiaryItem("item-drink", sourceFood, { amount: 100, unit: "ml" }),
    createDiaryItem("item-side", sourceFood, { amount: 50, unit: "ml" }),
  ],
};
const localDrink = createDiaryItem("item-drink", sourceFood, { amount: 150, unit: "ml" });
const remoteSide = createDiaryItem("item-side", sourceFood, { amount: 80, unit: "ml" });
const localMeal = { ...rebaseMeal, items: [localDrink, ...rebaseMeal.items.slice(1)] };
const remoteMeal = { ...rebaseMeal, items: [...rebaseMeal.items.slice(0, 1), remoteSide] };

async function stageStaleMeal(
  diary: Awaited<ReturnType<typeof openDiary>>,
  serverContent: unknown,
) {
  const journal = diary.sync.journal;
  const scope = { accountBinding: "account", lineage: "fixture", release: "0.1" };
  const base = decodeChange({
    kind: "meal",
    id: meal.id,
    state: "live",
    revision: 1,
    content: rebaseMeal,
  });
  const remote = decodeChange({ ...base, revision: 2, content: serverContent });
  let page = { ...scope, cursor: 1, hasMore: false, changes: [base] };
  const client = diarySyncClient((path) => {
    if (path === "/sync/pull") return Response.json(page);
    if (path !== "/sync/push") throw new Error("Unexpected sync request");
    return Response.json({
      ...scope,
      results: [
        { status: "conflict", reason: "stale", submissionId: "local-portion", current: remote },
      ],
    });
  });
  const session = await client.connect();
  journal.bind(session);
  journal.applyPage(session, 0, await client.pull(session, 0), () => undefined);
  diary.sync.saveMeal(localMeal, "local-portion");
  const attempt = journal.prepare(session);
  expect(attempt).toMatchObject([{ submissionId: "local-portion" }]);
  journal.applyResults(session, await client.push(session, attempt), () => undefined);
  page = { ...page, cursor: 2, changes: [remote] };
  journal.applyPage(session, 1, await client.pull(session, 1), () => undefined);
  return session;
}

test("rebases separated changes by meal item and commits the saved snapshot and retry together", async () => {
  const source = createDatabase();
  const diary = await source.start();
  const session = await stageStaleMeal(diary, remoteMeal);
  const blocked = diary.sync.journal.queued();
  source.db.exec(`CREATE TRIGGER stop_meal_rebase BEFORE INSERT ON edo_sync_outbox
    BEGIN SELECT RAISE(ABORT, 'journal unavailable'); END`);
  expect(() => diary.sync.tryRebaseMeal(session, meal.id, "merged-meal")).toThrow(
    /journal unavailable/,
  );
  expect(diary.getMeal(meal.id)).toEqual(localMeal);
  expect(diary.sync.journal.queued()).toEqual(blocked);
  source.db.exec("DROP TRIGGER stop_meal_rebase");

  expect(diary.sync.tryRebaseMeal(session, meal.id, "merged-meal")).toBe(true);
  source.db.close();
  const reopened = await createDatabase().start();
  const expected = { ...rebaseMeal, items: [localDrink, remoteSide] };
  expect(reopened.getMeal(meal.id)).toEqual(expected);
  const history = reopened.sync.journal.history();
  if (!history) throw new Error("Expected saved account history");
  const reconnected = await diarySyncClient(undefined, 2).connect(history);
  reopened.sync.journal.bind(reconnected);
  const [attempt] = reopened.sync.journal.prepare(reconnected);
  if (attempt?.op !== "put") throw new Error("Expected a rebased meal");
  expect(attempt).toMatchObject({
    submissionId: "merged-meal",
    baseRevision: 2,
    content: expected,
  });
  const server = reopened.sync.journal.serverCopy(attempt);
  if (server?.state !== "live") throw new Error("Expected the preserved server snapshot");
  expect(
    applyRecordContent({
      key: attempt,
      release: reconnected.release,
      current: server.content,
      submitted: attempt.content,
    }),
  ).toEqual(expected);
});

test("leaves overlapping, opaque, unjournaled and cross-meal edits for explicit review", async () => {
  const ownedItem = createDiaryItem("another-meals-item", sourceFood, { amount: 75, unit: "ml" });
  const otherMeal = { ...rebaseMeal, id: "another-meal", items: [ownedItem] };
  for (const [name, server, drift] of [
    [
      "overlap",
      {
        ...remoteMeal,
        items: [createDiaryItem("item-drink", sourceFood, { amount: 200, unit: "ml" }), remoteSide],
      },
      false,
    ],
    [
      "opaque",
      {
        ...remoteMeal,
        items: [...remoteMeal.items.slice(0, 1), { ...remoteSide, futureNutrition: 10 }],
      },
      false,
    ],
    ["shared-item", { ...remoteMeal, items: [...remoteMeal.items, ownedItem] }, false],
    ["drift", remoteMeal, true],
  ] as const) {
    const diary = await createDatabase(`${name}.db`).start();
    const session = await stageStaleMeal(diary, server);
    const actual = drift ? { ...localMeal, occurredAt: localMeal.occurredAt + 60_000 } : localMeal;
    if (drift) diary.saveMeal(actual);
    if (name === "shared-item") diary.saveMeal(otherMeal);
    const blocked = diary.sync.journal.queued();
    const evidence = diary.sync.journal.serverCopy({ kind: "meal", id: meal.id });
    expect(diary.sync.tryRebaseMeal(session, meal.id, "declined-meal")).toBe(false);
    expect(diary.getMeal(meal.id)).toEqual(actual);
    if (name === "shared-item") expect(diary.getMeal(otherMeal.id)).toEqual(otherMeal);
    expect(diary.sync.journal.queued()).toEqual(blocked);
    expect(diary.sync.journal.serverCopy({ kind: "meal", id: meal.id })).toEqual(evidence);
  }
});

test.each(["clean", "local edit", "legacy local deletion"] as const)(
  "reconciles a real paged meal swap after restarting with a %s diary",
  async (caseName) => {
    using store = openSyncStore(join(directory, "account.sqlite"), {
      applyContent: applyRecordContent,
    });
    store.createAccount("account", "fixture");
    await using server = createHealthServer({
      sync: {
        store,
        authorize(request) {
          const token = request.headers.authorization;
          if (token === "Bearer phone" || token === "Bearer tablet") {
            return { accountBinding: "account", sessionKey: token.slice(7) };
          }
          return null;
        },
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing sync test port");
    const makeClient = (device: string) =>
      createSyncClient({
        origin: `http://127.0.0.1:${address.port}`,
        allowLoopbackHttp: true,
        authorization: () => `Bearer ${device}`,
      });
    const phone = makeClient("phone");
    const tablet = makeClient("tablet");
    const phoneSession = await phone.connect();
    const source = createDatabase();
    const initial = await source.start();
    initial.sync.journal.bind(phoneSession);
    const leftItem = createDiaryItem("left-item", sourceFood, { amount: 50, unit: "ml" });
    const rightItem = createDiaryItem("right-item", sourceFood, { amount: 100, unit: "ml" });
    const left = { ...meal, id: "left", utcOffsetMinutes: -240, items: [leftItem] };
    const right = { ...meal, id: "right", utcOffsetMinutes: -240, items: [rightItem] };
    initial.sync.saveMeal(left, "phone-left");
    initial.sync.saveMeal(right, "phone-right");
    const uploaded = await phone.push(phoneSession, initial.sync.journal.prepare(phoneSession));
    expect(uploaded.results).toMatchObject([
      { status: "accepted", revision: 1 },
      { status: "accepted", revision: 2 },
    ]);
    expect(initial.sync.applyMealResults(phoneSession, uploaded)).toEqual({
      awaitingPages: true,
      deferred: [],
    });
    expect(initial.sync.journal.mealProjection(left.id)).toEqual({
      revision: 1,
      origin: "accepted",
      content: left,
    });
    expect(initial.sync.journal.serverCopy({ kind: "meal", id: right.id })).toBeNull();

    const tabletSession = await tablet.connect();
    const movedLeft = { ...left, items: [rightItem] };
    const movedRight = { ...right, items: [leftItem] };
    const changes = [
      {
        kind: "meal",
        id: left.id,
        submissionId: "tablet-empty-left",
        baseRevision: 1,
        content: { ...left, items: [] },
      },
      {
        kind: "meal",
        id: right.id,
        submissionId: "tablet-empty-right",
        baseRevision: 2,
        content: { ...right, items: [] },
      },
      {
        kind: "meal",
        id: left.id,
        submissionId: "tablet-add-right",
        baseRevision: 3,
        content: movedLeft,
      },
      {
        kind: "meal",
        id: right.id,
        submissionId: "tablet-add-left",
        baseRevision: 4,
        content: movedRight,
      },
      {
        kind: "weigh-in",
        id: weighIn.id,
        submissionId: "tablet-weight",
        baseRevision: null,
        content: weighIn,
      },
    ].map((change) => decodeSubmission({ ...change, op: "put" }));
    for (const [index, change] of changes.entries()) {
      expect((await tablet.push(tabletSession, [change])).results).toMatchObject([
        { status: "accepted", revision: index + 3 },
      ]);
    }
    const page = await phone.pull(phoneSession, 0, 1);
    expect(page).toMatchObject({ cursor: 5, hasMore: true });
    expect(initial.sync.applyMealPage(phoneSession, 0, page)).toEqual({
      awaitingPages: true,
      deferred: [],
    });
    expect(initial.getMeal(left.id)).toEqual(left);
    expect(initial.getMeal(right.id)).toEqual(right);
    source.db.close();

    const reopened = createDatabase();
    const diary = await reopened.start();
    const history = diary.sync.journal.history();
    if (!history) throw new Error("The diary lost its sync history");
    const active = await phone.connect(history);
    diary.sync.journal.bind(active);
    const localLeft =
      caseName === "local edit"
        ? { ...left, items: [updateDiaryPortion(leftItem, { amount: 175, unit: "ml" })] }
        : left;
    if (caseName === "local edit") diary.saveMeal(localLeft);
    if (caseName === "legacy local deletion") {
      // A v5 diary could carry the accepted revision without storing the local projection.
      reopened.db.prepare("DELETE FROM edo_sync_meal_projections WHERE id = ?").run(left.id);
      diary.deleteMeal(left.id);
    }
    const secondPage = await phone.pull(active, page.cursor, 1);
    expect(secondPage).toMatchObject({ cursor: 6, hasMore: true });
    expect(diary.sync.applyMealPage(active, page.cursor, secondPage)).toEqual({
      awaitingPages: true,
      deferred: [],
    });
    const finalPage = await phone.pull(active, secondPage.cursor, 1);
    expect(finalPage).toMatchObject({ cursor: 7, hasMore: false });
    if (caseName === "clean") {
      reopened.db.exec(`CREATE TRIGGER stop_swap BEFORE INSERT ON diary_items
        BEGIN SELECT RAISE(ABORT, 'simulated swap interruption'); END`);
      expect(() => diary.sync.applyMealPage(active, secondPage.cursor, finalPage)).toThrow(
        /swap interruption/,
      );
      expect(diary.getMeal(left.id)).toEqual(left);
      expect(diary.getMeal(right.id)).toEqual(right);
      expect(diary.sync.journal.history()?.cursor).toBe(secondPage.cursor);
      reopened.db.exec("DROP TRIGGER stop_swap");
    }
    const expectedDeferred = caseName === "clean" ? [] : [left.id, right.id];
    expect(diary.sync.applyMealPage(active, secondPage.cursor, finalPage)).toEqual({
      awaitingPages: false,
      deferred: expectedDeferred,
    });
    expect(diary.getMeal(left.id)).toEqual(
      caseName === "legacy local deletion"
        ? null
        : caseName === "local edit"
          ? localLeft
          : movedLeft,
    );
    expect(diary.getMeal(right.id)).toEqual(caseName === "clean" ? movedRight : right);
    expect(diary.sync.journal.serverCopy({ kind: "weigh-in", id: weighIn.id })).toMatchObject({
      revision: 7,
      content: weighIn,
    });
    expect(diary.listWeighIns(weighIn.localDay, weighIn.localDay)).toEqual([]);
    expect(diary.sync.replayMealProjections(active)).toEqual({
      awaitingPages: false,
      deferred: expectedDeferred,
    });
  },
);

test.each(["pending destination", "deleted source", "blocked source"] as const)(
  "defers both sides of a one-way transfer with a %s",
  async (scenario) => {
    const diary = await createDatabase().start();
    const left = { ...meal, id: "left" };
    const right = { ...meal, id: "right", items: [] };
    const nextLeft = { ...left, items: [] };
    const nextRight = { ...right, items: left.items };
    const editedLeft = { ...left, occurredAt: left.occurredAt + 60_000 };
    const editedRight = { ...right, occurredAt: right.occurredAt + 60_000 };
    const live = (content: DiaryMeal, revision: number) => ({
      kind: "meal",
      id: content.id,
      state: "live",
      revision,
      content,
    });
    const pages = [
      { cursor: 2, hasMore: false, changes: [live(left, 1), live(right, 2)] },
      { cursor: 3, hasMore: true, changes: [live(nextLeft, 3)] },
      { cursor: 4, hasMore: false, changes: [live(nextRight, 4)] },
    ];
    const wire = { release: "0.1", accountBinding: "account", lineage: "fixture" };
    const client = diarySyncClient((path) =>
      Response.json(
        path === "/sync/pull"
          ? { ...wire, ...pages.shift() }
          : {
              ...wire,
              results: [
                {
                  submissionId: "phone-edit",
                  status: "conflict",
                  reason: "stale",
                  current: live(nextLeft, 3),
                },
              ],
            },
      ),
    );
    const session = await client.connect();
    diary.sync.journal.bind(session);
    expect(diary.sync.applyMealPage(session, 0, await client.pull(session, 0)).deferred).toEqual(
      [],
    );

    if (scenario === "pending destination") diary.sync.saveMeal(editedRight, "phone-right");
    if (scenario === "deleted source") diary.deleteMeal(left.id);
    if (scenario === "blocked source") {
      diary.sync.saveMeal(editedLeft, "phone-edit");
      const response = await client.push(session, diary.sync.journal.prepare(session));
      expect(diary.sync.applyMealResults(session, response).awaitingPages).toBe(true);
    }
    expect(diary.sync.applyMealPage(session, 2, await client.pull(session, 2, 1))).toEqual({
      awaitingPages: true,
      deferred: [],
    });
    if (scenario === "blocked source") {
      expect(diary.sync.tryRebaseMeal(session, left.id, "too-early")).toBe(false);
    }
    expect(diary.sync.applyMealPage(session, 3, await client.pull(session, 3, 1))).toEqual({
      awaitingPages: false,
      deferred: [left.id, right.id],
    });
    if (scenario === "blocked source") {
      expect(diary.sync.tryRebaseMeal(session, left.id, "still-connected")).toBe(false);
    }
    expect(diary.getMeal(left.id)).toEqual(
      scenario === "deleted source" ? null : scenario === "blocked source" ? editedLeft : left,
    );
    expect(diary.getMeal(right.id)).toEqual(
      scenario === "pending destination" ? editedRight : right,
    );
  },
);

test.each(["pending delete", "pending put", "v5 revision only"] as const)(
  "keeps a moved item deferred through restart and later pages for a %s",
  async (scenario) => {
    using store = openSyncStore(join(directory, "remote-account.db"), {
      applyContent: applyRecordContent,
    });
    store.createAccount("account", "fixture");
    await using server = createHealthServer({
      sync: {
        store,
        authorize(request) {
          const id = request.headers.authorization;
          return id ? { accountBinding: "account", sessionKey: id } : null;
        },
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing sync test port");
    const origin = `http://127.0.0.1:${address.port}`;
    const client = (name: string) =>
      createSyncClient({ origin, allowLoopbackHttp: true, authorization: () => `Bearer ${name}` });
    const phone = client("phone");
    const tablet = client("tablet");
    let phoneSession = await phone.connect();
    const source = createDatabase();
    const left = { ...meal, id: "source" };
    const emptied = { ...left, items: [] };
    const right = { ...left, id: "destination" };
    const sourceKey = { kind: "meal", id: left.id };

    if (scenario === "v5 revision only") {
      const created = await phone.push(phoneSession, [
        decodeSubmission({
          ...sourceKey,
          op: "put",
          submissionId: "source-v5",
          baseRevision: null,
          content: left,
        }),
      ]);
      expect(created.results).toMatchObject([{ status: "accepted", revision: 1 }]);
      await migrateDiary(
        source.options.connection,
        diaryMigrations.slice(0, 5),
        source.options.backupBeforeMigration,
        () => {},
      );
      source.db
        .prepare("INSERT INTO edo_sync_binding VALUES (1, ?, 'account', 'fixture', 1, 0)")
        .run(origin);
      source.db.prepare("INSERT INTO edo_sync_outbox VALUES ('meal', ?, NULL, NULL, ?)").run(
        left.id,
        JSON.stringify({
          key: sourceKey,
          baseRevision: 1,
          base: null,
          attempt: null,
          pending: null,
          blocked: null,
        }),
      );
      source.db.prepare("INSERT INTO edo_sync_receipts VALUES ('source-v5')").run();
      source.db.prepare("INSERT INTO edo_sync_submission_ids VALUES ('source-v5')").run();
      phoneSession = await phone.connect();
    }

    const initial = await source.start();
    initial.sync.journal.bind(phoneSession);
    if (scenario !== "v5 revision only") {
      initial.sync.saveMeal(left, "source-put");
      const receipt = await phone.push(phoneSession, initial.sync.journal.prepare(phoneSession));
      if (scenario === "pending delete") initial.sync.deleteMeal(left.id, "newer-drop");
      else initial.sync.saveMeal(emptied, "newer-drop");
      initial.sync.applyMealResults(phoneSession, receipt);
      expect(initial.sync.journal.mealProjection(left.id)).toBeNull();
    }

    const tabletSession = await tablet.connect();
    const tail = (submissionId: string, baseRevision: number | null, kg: number) =>
      decodeSubmission({
        kind: "weigh-in",
        id: weighIn.id,
        op: "put",
        submissionId,
        baseRevision,
        content: { ...weighIn, kg },
      });
    const moved = await tablet.push(tabletSession, [
      decodeSubmission({
        ...sourceKey,
        op: "delete",
        submissionId: "tablet-delete",
        baseRevision: 1,
      }),
      decodeSubmission({
        kind: "meal",
        id: right.id,
        op: "put",
        content: right,
        submissionId: "tablet-add",
        baseRevision: null,
      }),
      tail("first-tail", null, 80),
    ]);
    expect(moved.results).toMatchObject([
      { status: "accepted", revision: 2 },
      { status: "accepted", revision: 3 },
      { status: "accepted", revision: 4 },
    ]);

    const first = await phone.pull(phoneSession, 0, 1);
    expect(initial.sync.applyMealPage(phoneSession, 0, first).awaitingPages).toBe(true);
    source.db.close();
    const reopened = createDatabase();
    const diary = await reopened.start();
    const session = await phone.connect(diary.sync.journal.history() ?? undefined);
    diary.sync.journal.bind(session);
    const second = await phone.pull(session, first.cursor, 1);
    expect(diary.sync.applyMealPage(session, first.cursor, second).awaitingPages).toBe(true);
    const terminal = await phone.pull(session, second.cursor, 1);
    const deferred = { awaitingPages: false, deferred: [left.id, right.id] };
    expect(diary.sync.applyMealPage(session, second.cursor, terminal)).toEqual(deferred);
    expect(diary.sync.replayMealProjections(session)).toEqual(deferred);
    expect(diary.getMeal(left.id)).toEqual(scenario === "pending put" ? emptied : null);
    expect(diary.getMeal(right.id)).toBeNull();

    expect((await tablet.push(tabletSession, [tail("second-tail", 4, 81)])).results).toMatchObject([
      { status: "accepted", revision: 5 },
    ]);
    expect(
      diary.sync.applyMealPage(
        session,
        terminal.cursor,
        await phone.pull(session, terminal.cursor),
      ),
    ).toEqual(deferred);
    expect(diary.getMeal(right.id)).toBeNull();
    if (scenario === "pending delete") {
      const receipt = await phone.push(session, diary.sync.journal.prepare(session));
      expect(receipt.results).toMatchObject([{ status: "accepted", revision: 2 }]);
      reopened.db.exec(`CREATE TRIGGER stop_replay BEFORE INSERT ON diary_items
        BEGIN SELECT RAISE(ABORT, 'simulated deferred replay interruption'); END`);
      expect(() => diary.sync.applyMealResults(session, receipt)).toThrow(/replay interruption/);
      expect(diary.sync.journal.queued()).toEqual([]);
      expect(diary.getMeal(right.id)).toBeNull();
      reopened.db.exec("DROP TRIGGER stop_replay");
      expect(diary.sync.applyMealResults(session, receipt).deferred).toEqual([]);
      expect(diary.sync.applyMealResults(session, receipt).deferred).toEqual([]);
      expect(diary.getMeal(left.id)).toBeNull();
      expect(diary.getMeal(right.id)).toEqual(right);
    }
  },
);

test.each(["staged pull", "conflict receipt"] as const)(
  "retains ownership seen only in a %s after an unbased delete and superseding page",
  async (observation) => {
    using store = openSyncStore(join(directory, "remote-account.db"), {
      applyContent: applyRecordContent,
    });
    store.createAccount("account", "fixture");
    await using server = createHealthServer({
      sync: {
        store,
        authorize(request) {
          const token = request.headers.authorization;
          return token ? { accountBinding: "account", sessionKey: token } : null;
        },
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing sync test port");
    const origin = `http://127.0.0.1:${address.port}`;
    const client = (name: string) =>
      createSyncClient({ origin, allowLoopbackHttp: true, authorization: () => `Bearer ${name}` });
    const tablet = client("tablet");
    const tabletSession = await tablet.connect();
    const phone = client("phone");
    const left = { ...meal, id: "source" };
    const right = { ...left, id: "destination" };
    const sourceKey = { kind: "meal", id: left.id };
    expect(
      (
        await tablet.push(tabletSession, [
          decodeSubmission({
            ...sourceKey,
            op: "put",
            baseRevision: null,
            content: left,
            submissionId: "tablet-create",
          }),
        ])
      ).results,
    ).toMatchObject([{ status: "accepted", revision: 1 }]);

    const source = createDatabase();
    const original = await source.start();
    const divergent = { ...left, items: [], occurredAt: left.occurredAt + 60_000 };
    original.saveMeal(divergent);
    let session = await phone.connect();
    original.sync.journal.bind(session);
    if (observation === "staged pull") {
      const page = await phone.pull(session, 0);
      expect(original.sync.applyMealPage(session, 0, page).deferred).toEqual([left.id]);
    } else {
      original.sync.saveMeal(divergent, "first-phone-attempt");
      const attempt = original.sync.journal.prepare(session);
      const reply = await phone.push(session, attempt);
      expect(reply.results).toMatchObject([
        { status: "conflict", current: { state: "live", revision: 1, content: left } },
      ]);
      original.sync.applyMealResults(session, reply);
    }
    expect(source.db.prepare("SELECT * FROM edo_sync_staged_meal_claims").all()).toEqual([
      { id: left.id, item_ids: JSON.stringify(left.items.map(({ id }) => id)), unknown_prior: 0 },
    ]);
    expect(original.sync.journal.mealProjection(left.id)).toBeNull();
    original.sync.deleteMeal(left.id, "local-delete");
    expect(original.sync.journal.queued()).toMatchObject([
      { key: sourceKey, baseRevision: null, pending: { op: "delete" } },
    ]);
    source.db.close();

    const moved = await tablet.push(tabletSession, [
      decodeSubmission({
        ...sourceKey,
        op: "delete",
        baseRevision: 1,
        submissionId: "tablet-delete",
      }),
      decodeSubmission({
        kind: "meal",
        id: right.id,
        op: "put",
        content: right,
        baseRevision: null,
        submissionId: "tablet-move",
      }),
    ]);
    expect(moved.results).toMatchObject([
      { status: "accepted", revision: 2 },
      { status: "accepted", revision: 3 },
    ]);
    const reopening = createDatabase();
    const diary = await reopening.start();
    const history = diary.sync.journal.history();
    if (!history) throw new Error("Expected the resumed phone connection");
    session = await phone.connect(history);
    diary.sync.journal.bind(session);
    const page = await phone.pull(session, history.cursor);
    reopening.db.exec(`
      CREATE TRIGGER stop_claim_write BEFORE INSERT ON edo_sync_staged_meal_claims
      WHEN NEW.id = 'destination' BEGIN SELECT RAISE(ABORT, 'simulated claim interruption'); END
    `);
    expect(() => diary.sync.applyMealPage(session, history.cursor, page)).toThrow(
      /claim interruption/,
    );
    expect(diary.sync.journal.history()?.cursor).toBe(history.cursor);
    expect(diary.sync.journal.serverCopy(sourceKey)?.revision).toBe(
      observation === "staged pull" ? 1 : undefined,
    );
    reopening.db.exec("DROP TRIGGER stop_claim_write");
    expect(diary.sync.applyMealPage(session, history.cursor, page).deferred).toEqual([
      left.id,
      right.id,
    ]);
    expect(diary.sync.journal.serverCopy(sourceKey)).toMatchObject({
      state: "deleted",
      revision: 2,
    });
    expect(diary.sync.replayMealProjections(session).deferred).toEqual([left.id, right.id]);
    expect(diary.getMeal(left.id)).toBeNull();
    expect(diary.getMeal(right.id)).toBeNull();
    expect(diary.sync.journal.queued()).toMatchObject([
      { key: sourceKey, baseRevision: null, pending: { op: "delete" } },
    ]);
    expect(
      reopening.db
        .prepare("SELECT item_ids FROM edo_sync_staged_meal_claims WHERE id = ?")
        .get(left.id),
    ).toEqual({ item_ids: JSON.stringify(left.items.map(({ id }) => id)) });
  },
);

test("leaves first local writes unbased when authenticated account copies are only staged", async () => {
  const diary = await createDatabase().start();
  diary.saveMeal({ ...meal, occurredAt: meal.occurredAt + 60_000 });
  const client = diarySyncClient(() =>
    Response.json({
      release: "0.1",
      accountBinding: "account",
      lineage: "fixture",
      cursor: 2,
      hasMore: false,
      changes: [
        { kind: "meal", id: meal.id, state: "live", revision: 1, content: meal },
        { kind: "weigh-in", id: weighIn.id, state: "live", revision: 2, content: weighIn },
      ],
    }),
  );
  const session = await client.connect();
  diary.sync.journal.bind(session);
  expect(diary.sync.applyMealPage(session, 0, await client.pull(session, 0))).toEqual({
    awaitingPages: false,
    deferred: [meal.id],
  });
  diary.sync.deleteMeal(meal.id, "local-delete");
  diary.sync.saveWeighIn({ ...weighIn, kg: 81 }, "local-weigh-in");
  expect(diary.sync.journal.prepare(session)).toMatchObject([
    { submissionId: "local-delete", baseRevision: null },
    { submissionId: "local-weigh-in", baseRevision: null },
  ]);
  expect(diary.sync.journal.serverCopy({ kind: "meal", id: meal.id })).toMatchObject({
    revision: 1,
    state: "live",
  });
});

test("commits a bound weigh-in and its pending tombstone with the private diary", async () => {
  const source = createDatabase();
  const diary = await source.start();
  const saved = { ...weighIn, kg: 81.25 };
  diary.saveWeighIn(weighIn);
  expect(diary.sync.journal.queued()).toEqual([]);
  expect(() => diary.sync.saveWeighIn(saved, "unbound")).toThrow(/Connect this diary/);
  expect(diary.listWeighIns(weighIn.localDay, weighIn.localDay)).toEqual([weighIn]);

  const session = await diarySyncSession();
  diary.sync.journal.bind(session);
  diary.sync.saveWeighIn(saved, "save-weight");
  const [attempt] = diary.sync.journal.prepare(session);
  if (attempt?.op !== "put") throw new Error("Expected a weigh-in submission");
  expect(attempt).toMatchObject({ kind: "weigh-in", id: weighIn.id, content: saved });
  expect(
    applyRecordContent({
      key: attempt,
      release: session.release,
      current: null,
      submitted: attempt.content,
    }),
  ).toEqual(saved);

  source.db.exec(`CREATE TRIGGER deny_weight_outbox BEFORE INSERT ON edo_sync_outbox
    WHEN NEW.kind = 'weigh-in' BEGIN SELECT RAISE(ABORT, 'journal unavailable'); END`);
  expect(() => diary.sync.deleteWeighIn(weighIn.id, "delete-weight")).toThrow(
    /journal unavailable/,
  );
  expect(diary.listWeighIns(weighIn.localDay, weighIn.localDay)).toEqual([saved]);
  expect(diary.sync.journal.queued()).toMatchObject([{ attempt, pending: null }]);
  source.db.exec("DROP TRIGGER deny_weight_outbox");
  diary.sync.deleteWeighIn(weighIn.id, "delete-weight");

  source.db.close();
  const reopened = await createDatabase().start();
  expect(reopened.listWeighIns(weighIn.localDay, weighIn.localDay)).toEqual([]);
  expect(reopened.sync.journal.queued()).toMatchObject([
    { attempt, pending: { op: "delete", submissionId: "delete-weight" } },
  ]);
});

test("reopens locally, preserving the event day, stable IDs and nutrition after a catalog refresh", async () => {
  const source = createDatabase();
  const diary = await source.start();
  diary.saveMeal(meal);
  diary.saveMeal(meal);
  source.db.close();

  const secondRelease: Food = {
    ...sourceFood,
    name: "Soy drink, new label",
    release: "fixture-b",
    nutrition: {
      ...sourceFood.nutrition,
      nutrients: { ...sourceFood.nutrition.nutrients, kcal: 120, fiberG: 2 },
    },
  };
  const reopened = await createDatabase().start();
  reopened.saveMeal({
    id: "meal-next",
    localDay: "2026-11-01",
    occurredAt: meal.occurredAt + 1,
    items: [createDiaryItem("item-next", secondRelease, { amount: 0.5, unit: "portion" })],
  });

  expect(reopened.listMeals("2026-10-31")).toEqual([meal]);
  expect(reopened.getMeal(meal.id)?.items[0]).toMatchObject({
    food: { id: { sourceId: "00012345" }, release: "fixture-a" },
    nutrients: { kcal: 80, availableCarbohydratesG: 0, fiberG: null },
  });
  expect(reopened.listMeals("2026-11-01")[0]?.items[0]?.nutrients).toMatchObject({
    kcal: 120,
    fiberG: 2,
  });
});

test("round-trips the captured offset for two occurrences of a DST wall time", async () => {
  const source = createDatabase();
  const diary = await source.start();
  const earlier: DiaryMeal = {
    ...meal,
    localDay: "2026-11-01",
    occurredAt: Date.parse("2026-11-01T05:30:00Z"),
    utcOffsetMinutes: -240,
  };
  const later: DiaryMeal = {
    id: "meal-fallback",
    localDay: earlier.localDay,
    occurredAt: Date.parse("2026-11-01T06:30:00Z"),
    utcOffsetMinutes: -300,
    items: [],
  };
  diary.saveMeal(earlier);
  diary.saveMeal(later);
  expect(() => diary.saveMeal({ ...earlier, utcOffsetMinutes: -240.5 })).toThrow(/UTC offset/);
  expect(() => diary.saveMeal({ ...earlier, utcOffsetMinutes: 1440 })).toThrow(/UTC offset/);
  source.db.close();

  const reopened = await createDatabase().start();
  expect(reopened.listMeals(earlier.localDay)).toEqual([earlier, later]);
  reopened.saveMeal({ ...earlier, utcOffsetMinutes: undefined });
  expect(reopened.getMeal(earlier.id)).toEqual(earlier);
  const moved = { ...earlier, occurredAt: later.occurredAt, utcOffsetMinutes: undefined };
  reopened.saveMeal(moved);
  expect(reopened.getMeal(earlier.id)?.utcOffsetMinutes).toBeUndefined();
});

test("deletes a meal and its items in a retryable transaction", async () => {
  const source = createDatabase();
  const diary = await source.start();
  diary.saveMeal(meal);
  diary.saveMeal({ ...meal, id: "other-meal", items: [] });
  diary.deleteMeal(meal.id);
  diary.deleteMeal(meal.id);
  source.db.close();

  const reopened = createDatabase();
  const restored = await reopened.start();
  expect(restored.getMeal(meal.id)).toBeNull();
  expect(restored.listMeals(meal.localDay).map(({ id }) => id)).toEqual(["other-meal"]);
  expect(reopened.options.connection.get("SELECT id FROM diary_items")).toBeUndefined();
});

test("migrates a version-one diary while preserving its snapshots and absent offset", async () => {
  const source = createDatabase();
  const { connection, backupBeforeMigration } = source.options;
  await migrateDiary(connection, diaryMigrations.slice(0, 1), backupBeforeMigration, () => {});
  connection.run(
    "INSERT INTO diary_meals VALUES (?, ?, ?)",
    meal.id,
    meal.localDay,
    meal.occurredAt,
  );
  const item = meal.items[0];
  if (!item) throw new Error("Expected a legacy diary item fixture");
  const { id, ...snapshot } = item;
  connection.run(
    "INSERT INTO diary_items VALUES (?, ?, 0, ?)",
    id,
    meal.id,
    JSON.stringify(snapshot),
  );

  const upgraded = await source.start();
  expect(upgraded.getMeal(meal.id)).toEqual(meal);
  expect(connection.get("PRAGMA user_version")?.user_version).toBe(currentVersion);
  expect(connection.get("PRAGMA application_id")?.application_id).toBe(0x45444f44);
  expect(source.snapshots).toHaveLength(1);
});

function initializePublishedV2(connection: DiarySqliteConnection) {
  // This is the published schema, including its identity and UTC offset field.
  connection.exec(`
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
    ALTER TABLE diary_meals ADD COLUMN utc_offset_minutes INTEGER
      CHECK (utc_offset_minutes IS NULL OR
        (typeof(utc_offset_minutes) = 'integer' AND utc_offset_minutes BETWEEN -1439 AND 1439));
    PRAGMA application_id = 1162104644;
    PRAGMA user_version = 2;
  `);
}

test("upgrades a published version-two diary and can restore its verified recovery copy", async () => {
  const current = createDatabase();
  const { connection } = current.options;
  initializePublishedV2(connection);
  const fallBack = [
    {
      ...meal,
      id: "earlier-occurrence",
      localDay: "2026-11-01",
      occurredAt: Date.parse("2026-11-01T05:30:00Z"),
      utcOffsetMinutes: -240,
      items: [],
    },
    {
      ...meal,
      id: "later-occurrence",
      localDay: "2026-11-01",
      occurredAt: Date.parse("2026-11-01T06:30:00Z"),
      utcOffsetMinutes: -300,
      items: [],
    },
  ];
  for (const entry of [meal, ...fallBack]) {
    connection.run(
      "INSERT INTO diary_meals VALUES (?, ?, ?, ?)",
      entry.id,
      entry.localDay,
      entry.occurredAt,
      entry.utcOffsetMinutes ?? null,
    );
  }
  const item = meal.items[0];
  if (!item) throw new Error("Expected a captured item");
  const { id, ...captured } = item;
  connection.run(
    "INSERT INTO diary_items VALUES (?, ?, 0, ?)",
    id,
    meal.id,
    JSON.stringify(captured),
  );

  const upgraded = await current.start();
  expect(connection.get("PRAGMA user_version")?.user_version).toBe(currentVersion);
  expect(upgraded.getMeal(meal.id)).toEqual(meal);
  expect(upgraded.listMeals("2026-11-01")).toEqual(fallBack);
  expect(upgraded.listWeighIns("2026-10-31", "2026-11-01")).toEqual([]);
  expect(upgraded.nutritionTargetAt("2026-11-01")).toBeNull();

  const path = current.snapshots[0];
  if (!path) throw new Error("Expected a verified recovery copy");
  using snapshot = new DatabaseSync(path, { readOnly: true });
  expect(snapshot.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
  expect(
    snapshot.prepare("SELECT name FROM sqlite_schema WHERE name = 'diary_targets'").get(),
  ).toBeUndefined();
  await backup(snapshot, join(directory, "restored-v2.db"));
  const restored = await createDatabase("restored-v2.db").start();
  expect(restored.getMeal(meal.id)).toEqual(meal);
  expect(restored.listMeals("2026-11-01")).toEqual(fallBack);
});

test("upgrades and restores a version-three diary with progress and captured meal values", async () => {
  const source = createDatabase();
  const { connection } = source.options;
  initializePublishedV2(connection);
  connection.exec(`
    CREATE TABLE diary_weigh_ins (
      id TEXT PRIMARY KEY NOT NULL,
      local_day TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      kg REAL NOT NULL CHECK (kg > 0)
    ) STRICT;
    CREATE INDEX diary_weigh_ins_by_day ON diary_weigh_ins (local_day, occurred_at, id);
    CREATE TABLE diary_targets (
      save_order INTEGER PRIMARY KEY CHECK (save_order > 0),
      id TEXT UNIQUE NOT NULL,
      effective_day TEXT NOT NULL,
      configured_at INTEGER NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('manual', 'calculated')),
      kcal REAL NOT NULL CHECK (kcal > 0),
      protein_g REAL NOT NULL CHECK (protein_g >= 0),
      fat_g REAL NOT NULL CHECK (fat_g >= 0),
      carbohydrate_g REAL NOT NULL CHECK (carbohydrate_g >= 0)
    ) STRICT;
    CREATE INDEX diary_targets_by_day ON diary_targets (effective_day, save_order);
    PRAGMA user_version = 3;
  `);
  const captured = { ...meal, utcOffsetMinutes: -300 };
  connection.run(
    "INSERT INTO diary_meals VALUES (?, ?, ?, ?)",
    captured.id,
    captured.localDay,
    captured.occurredAt,
    captured.utcOffsetMinutes,
  );
  const [item] = captured.items;
  if (!item) throw new Error("Expected a captured meal item");
  const { id, ...snapshot } = item;
  connection.run(
    "INSERT INTO diary_items VALUES (?, ?, 0, ?)",
    id,
    meal.id,
    JSON.stringify(snapshot),
  );
  connection.run(
    "INSERT INTO diary_weigh_ins VALUES (?, ?, ?, ?)",
    weighIn.id,
    weighIn.localDay,
    weighIn.occurredAt,
    weighIn.kg,
  );
  for (const record of [target, revisedTarget]) {
    connection.run(
      "INSERT INTO diary_targets VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?)",
      record.id,
      record.effectiveDay,
      record.configuredAt,
      record.mode,
      record.target.kcal,
      record.target.proteinG,
      record.target.fatG,
      record.target.availableCarbohydratesG,
    );
  }
  const interrupted = {
    ...connection,
    exec(sql: string) {
      connection.exec(sql);
      if (sql.includes("CREATE TABLE diary_custom_foods")) throw new Error("Interrupted upgrade");
    },
  };
  await expect(openDiary({ ...source.options, connection: interrupted })).rejects.toThrow(
    /interrupted upgrade/i,
  );
  expect(connection.get("PRAGMA user_version")?.user_version).toBe(3);
  expect(
    connection.get("SELECT name FROM sqlite_schema WHERE name = 'diary_custom_foods'"),
  ).toBeUndefined();
  const recovery = source.snapshots[0];
  if (!recovery) throw new Error("Expected a verified version-three copy");
  using original = new DatabaseSync(recovery, { readOnly: true });
  expect(original.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
  await backup(original, join(directory, "restored-v3.db"));

  for (const diary of [await source.start(), await createDatabase("restored-v3.db").start()]) {
    expect(diary.getMeal(meal.id)).toEqual(captured);
    expect(diary.listWeighIns(weighIn.localDay, weighIn.localDay)).toEqual([weighIn]);
    expect(diary.nutritionTargetAt(revisedTarget.effectiveDay)).toEqual(revisedTarget);
    expect(diary.listCustomFoods()).toEqual([]);
    expect(diary.listRecipes()).toEqual([]);
    expect(diary.listMealTemplates()).toEqual([]);
    expect(diary.listFavorites()).toEqual([]);
  }
});

test("saves offline weigh-ins and preserves effective target revisions in save order", async () => {
  const source = createDatabase();
  const diary = await source.start();
  diary.saveWeighIn(weighIn);
  diary.saveWeighIn({ ...weighIn, kg: 79 });
  expect(() => diary.saveWeighIn({ ...weighIn, kg: Infinity })).toThrow(/weight/);
  expect(() => diary.listWeighIns("2026-11-01", "2026-10-31")).toThrow(/range/);

  const future = { ...target, id: "future-target", effectiveDay: "2026-11-03" };
  diary.saveNutritionTarget(target);
  diary.saveNutritionTarget(revisedTarget);
  diary.saveNutritionTarget(target);
  diary.saveNutritionTarget(future);
  expect(() => diary.saveNutritionTarget({ ...target, mode: "calculated" })).toThrow(
    /new revision ID/,
  );
  expect(diary.nutritionTargetAt("2026-10-30")).toBeNull();
  expect(diary.nutritionTargetAt("2026-10-31")).toEqual(revisedTarget);
  expect(diary.nutritionTargetAt("2026-11-03")).toEqual(future);
  source.db.close();

  const reopened = await createDatabase().start();
  expect(reopened.listWeighIns("2026-10-31", "2026-10-31")).toEqual([{ ...weighIn, kg: 79 }]);
  expect(reopened.listWeighIns("2026-11-01", "2026-11-01")).toEqual([]);
  expect(reopened.nutritionTargetAt("2026-11-01")).toEqual(revisedTarget);
});

test("rejects a new target with an inconsistent energy budget", async () => {
  const diary = await createDatabase().start();
  diary.saveNutritionTarget(target);
  expect(() =>
    diary.saveNutritionTarget({
      ...revisedTarget,
      target: { ...revisedTarget.target, kcal: 1 },
    }),
  ).toThrow(/protein and fat exceed/i);
  expect(() =>
    diary.saveNutritionTarget({
      ...revisedTarget,
      target: { ...revisedTarget.target, availableCarbohydratesG: 1 },
    }),
  ).toThrow(/carbohydrate target/i);
  expect(diary.nutritionTargetAt(revisedTarget.effectiveDay)).toEqual(target);
  diary.saveNutritionTarget(revisedTarget);
  expect(diary.nutritionTargetAt(revisedTarget.effectiveDay)).toEqual(revisedTarget);
});

test.each(["weigh-in", "target", "save order"] as const)(
  "rejects a current backup with different progress %s values",
  async (difference) => {
    const source = createDatabase();
    const current = await source.start();
    const older = createDatabase("older.db");
    const stale = await older.start();
    current.saveMeal(meal);
    stale.saveMeal(meal);
    current.saveWeighIn(weighIn);
    stale.saveWeighIn(difference === "weigh-in" ? { ...weighIn, kg: 77 } : weighIn);
    current.saveNutritionTarget(target);
    current.saveNutritionTarget(revisedTarget);
    if (difference === "save order") stale.saveNutritionTarget(revisedTarget);
    stale.saveNutritionTarget(difference === "target" ? { ...target, mode: "calculated" } : target);
    if (difference !== "save order") stale.saveNutritionTarget(revisedTarget);

    await expect(
      migrateDiary(
        source.options.connection,
        [...diaryMigrations, (db) => db.exec("ALTER TABLE diary_meals ADD COLUMN memo TEXT")],
        async (_version, verify) => verify(older.options.connection),
        () => {},
      ),
    ).rejects.toThrow(/backup does not match/i);
    expect(source.options.connection.get("PRAGMA user_version")?.user_version).toBe(currentVersion);
    expect(current.listWeighIns("2026-10-31", "2026-10-31")).toEqual([weighIn]);
    expect(current.nutritionTargetAt("2026-10-31")).toEqual(revisedTarget);
  },
);

test("keeps recipe ingredients and logged portions after editing and deleting a custom food", async () => {
  const source = createDatabase();
  const diary = await source.start();
  const custom: Food = {
    ...sourceFood,
    id: { provider: "local", sourceId: "custom-mix" },
    name: "Synthetic mix",
    release: null,
  };
  diary.saveCustomFood(custom);
  diary.setFavorite(custom.id, true);
  diary.setFavorite(sourceFood.id, true);
  diary.setFavorite(sourceFood.id, true);
  const ingredient = createDiaryItem("ingredient-mix", custom, { amount: 100, unit: "ml" });
  const recipe = {
    id: "recipe-mix",
    name: "Synthetic recipe",
    ingredients: [ingredient],
    servings: 2,
    cookedWeightG: 240,
  };
  diary.saveRecipe(recipe);
  const logged = createDiaryItem("logged-recipe", foodForRecipe(recipe), {
    amount: 120,
    unit: "g",
  });
  expect(logged.nutrients.kcal).toBe(40);
  diary.saveMeal({ ...meal, items: [logged] });
  const edited = {
    ...recipe,
    ingredients: [updateDiaryPortion(ingredient, { amount: 200, unit: "ml" })],
  };
  diary.saveRecipe(edited);
  diary.deleteCustomFood(custom.id.sourceId);
  diary.deleteCustomFood(custom.id.sourceId);
  source.db.close();

  const reopened = await createDatabase().start();
  expect(reopened.listCustomFoods()).toEqual([]);
  expect(reopened.listFavorites()).toEqual([sourceFood.id]);
  expect(reopened.listRecipes()).toEqual([edited]);
  expect(foodForRecipe(edited).nutrition.nutrients.kcal).toBe(80);
  expect(reopened.getMeal(meal.id)?.items[0]).toEqual(logged);
});

test("repeats a saved meal with fresh IDs, its new captured offset, and the original portions", async () => {
  const source = createDatabase();
  const diary = await source.start();
  const template = { id: "saved-meal", name: "Synthetic lunch", items: meal.items };
  const original = meal.items[0];
  if (!original) throw new Error("The test fixture needs a diary item");
  const incomplete: DiaryMeal["items"] = new Array(2);
  expect(() => diary.saveMealTemplate({ ...template, items: incomplete })).toThrow(/record/);
  diary.saveMealTemplate(template);
  const saved = diary.listMealTemplates()[0];
  if (!saved) throw new Error("Expected a saved meal template");
  expect(saved).toEqual(template);
  const entry = {
    id: "repeated-meal",
    localDay: "2026-11-05",
    occurredAt: Date.parse("2026-11-06T04:30:00Z"),
    utcOffsetMinutes: -300,
  };
  expect(() => mealFromTemplate(saved, entry, () => original.id)).toThrow(/fresh item IDs/);
  expect(() =>
    mealFromTemplate(saved, { ...entry, utcOffsetMinutes: Infinity }, () => "new-item"),
  ).toThrow(/UTC offset/);
  const repeated = mealFromTemplate(saved, entry, () => "new-item");
  diary.saveMeal(repeated);
  diary.saveMeal(repeated);
  source.db.close();
  const reopened = await createDatabase().start();
  expect(reopened.listMeals(entry.localDay)).toEqual([
    { ...entry, items: [{ ...original, id: "new-item" }] },
  ]);
  expect(reopened.listMealTemplates()).toEqual([template]);
});

test.each(["custom food", "recipe", "template", "favorite"] as const)(
  "rejects a verified-shape backup with a different %s",
  async (difference) => {
    const source = createDatabase();
    const older = createDatabase("older-library.db");
    const current = await source.start();
    const stale = await older.start();
    const food: Food = {
      ...sourceFood,
      id: { provider: "local", sourceId: "backup-food" },
      release: null,
    };
    const recipe = {
      id: "backup-recipe",
      name: "Synthetic recipe",
      ingredients: meal.items,
      servings: 2,
    };
    const template = { id: "backup-meal", name: "Synthetic meal", items: meal.items };
    current.saveCustomFood(food);
    current.saveRecipe(recipe);
    current.saveMealTemplate(template);
    current.setFavorite(sourceFood.id, true);
    stale.saveCustomFood(difference === "custom food" ? { ...food, name: "Old name" } : food);
    stale.saveRecipe(difference === "recipe" ? { ...recipe, servings: 1 } : recipe);
    stale.saveMealTemplate(
      difference === "template" ? { ...template, name: "Old meal" } : template,
    );
    stale.setFavorite(difference === "favorite" ? food.id : sourceFood.id, true);

    await expect(
      migrateDiary(
        source.options.connection,
        [...diaryMigrations, (db) => db.exec("ALTER TABLE diary_meals ADD COLUMN memo TEXT")],
        async (_version, verify) => verify(older.options.connection),
        () => {},
      ),
    ).rejects.toThrow(/backup does not match/i);
    expect(source.options.connection.get("PRAGMA user_version")?.user_version).toBe(currentVersion);
    expect(current.listCustomFoods()).toEqual([food]);
    expect(current.listRecipes()).toEqual([recipe]);
    expect(current.listMealTemplates()).toEqual([template]);
    expect(current.listFavorites()).toEqual([sourceFood.id]);
  },
);

test.each([1, 2, 3, currentVersion])(
  "rejects a version-%i catalog at the diary open boundary",
  async (version) => {
    const source = createDatabase();
    source.db.exec(
      `CREATE TABLE catalog_metadata (release TEXT); PRAGMA user_version = ${version}`,
    );
    await expect(source.start()).rejects.toThrow(/does not belong to the Edo diary/);
    expect(source.options.connection.get("PRAGMA user_version")?.user_version).toBe(version);
    expect(source.options.connection.all("SELECT name FROM sqlite_schema")).toEqual([
      { name: "catalog_metadata" },
    ]);
    expect(source.snapshots).toEqual([]);
  },
);

test("does not claim a database with lookalike version-one table names", async () => {
  const source = createDatabase();
  source.db.exec(`
    CREATE TABLE diary_meals (id TEXT PRIMARY KEY, local_day TEXT, occurred_at INTEGER);
    CREATE TABLE diary_items (id TEXT PRIMARY KEY, meal_id TEXT, position INTEGER, snapshot TEXT);
    INSERT INTO diary_meals VALUES ('other-app', '2026-10-31', 0);
    PRAGMA user_version = 1;
  `);
  await expect(source.start()).rejects.toThrow(/does not belong to the Edo diary/);
  const { connection } = source.options;
  expect(connection.get("PRAGMA user_version")?.user_version).toBe(1);
  expect(connection.get("PRAGMA application_id")?.application_id).toBe(0);
  expect(connection.get("SELECT id FROM diary_meals")?.id).toBe("other-app");
  expect(source.snapshots).toEqual([]);
});

test("rolls back all writes in an incomplete meal replacement", async () => {
  const source = createDatabase();
  const diary = await source.start();
  const otherItem = createDiaryItem("item-other", sourceFood, { amount: 50, unit: "ml" });
  const otherMeal = { ...meal, id: "meal-other", items: [otherItem] };
  diary.saveMeal(meal);
  diary.saveMeal(otherMeal);

  expect(() =>
    diary.saveMeal({
      ...meal,
      localDay: "2026-11-01",
      items: [createDiaryItem("item-new", sourceFood, { amount: 250, unit: "ml" }), otherItem],
    }),
  ).toThrow(/UNIQUE constraint failed/);
  source.db.close();

  const reopened = await createDatabase().start();
  expect(reopened.getMeal(meal.id)).toEqual(meal);
  expect(reopened.getMeal(otherMeal.id)).toEqual(otherMeal);
  expect(reopened.listMeals("2026-11-01")).toEqual([]);
});

test("updates a meal's stored portions, keeps stable item identities, and lists meals by instant", async () => {
  const diary = await createDatabase().start();
  diary.saveMeal(meal);
  const earlier = { ...meal, id: "meal-earlier", occurredAt: meal.occurredAt - 1, items: [] };
  diary.saveMeal(earlier);
  const items = [
    createDiaryItem("item-other", sourceFood, { amount: 50, unit: "ml" }),
    createDiaryItem("item-drink", sourceFood, { amount: 150, unit: "ml" }),
  ];
  diary.saveMeal({ ...meal, items });

  expect(diary.listMeals(meal.localDay)).toEqual([earlier, { ...meal, items }]);
  expect(diary.getMeal("missing")).toBeNull();
  expect(() => diary.saveMeal({ ...meal, localDay: "2026-02-29" })).toThrow(/calendar day/);
  expect(diary.getMeal(meal.id)).toEqual({ ...meal, items });
});

test("preserves well-formed Unicode IDs and refuses IDs SQLite would replace", async () => {
  const diary = await createDatabase().start();
  const replacementCharacter = {
    ...meal,
    id: "meal-\uFFFD",
    items: [createDiaryItem("item-\uFFFD", sourceFood, { amount: 50, unit: "ml" })],
  };
  const astral = {
    ...meal,
    id: "meal-🍽",
    items: [createDiaryItem("item-🍚", sourceFood, { amount: 100, unit: "ml" })],
  };
  diary.saveMeal(replacementCharacter);
  diary.saveMeal(astral);

  expect(() => diary.saveMeal({ ...replacementCharacter, id: "meal-\uD800", items: [] })).toThrow(
    /Invalid diary meal ID/,
  );
  expect(() => diary.getMeal("meal-\uD800")).toThrow(/Invalid diary meal ID/);
  expect(() =>
    diary.saveMeal({
      ...replacementCharacter,
      items: [createDiaryItem("item-\uDC00", sourceFood, { amount: 25, unit: "ml" })],
    }),
  ).toThrow(/Invalid diary item ID/);
  expect(diary.getMeal(replacementCharacter.id)).toEqual(replacementCharacter);
  expect(diary.getMeal(astral.id)).toEqual(astral);
});

test("backs up old data and rolls back invalid migrated rows before changing the version", async () => {
  const source = createDatabase();
  const diary = await source.start();
  source.db.exec("PRAGMA journal_mode = WAL");
  diary.saveMeal(meal);
  const editedMeal: DiaryMeal = {
    ...meal,
    items: [createDiaryItem("item-drink", sourceFood, { amount: 150, unit: "ml" })],
  };
  diary.saveMeal(editedMeal);
  const checkItems = (db: DiarySqliteConnection) => {
    for (const row of db.all("SELECT snapshot FROM diary_items")) {
      decodeSnapshot(row.snapshot);
    }
  };
  const { connection, backupBeforeMigration } = source.options;

  await expect(
    migrateDiary(
      connection,
      [
        ...diaryMigrations,
        (db) => {
          db.exec("ALTER TABLE diary_meals ADD COLUMN memo TEXT");
          db.run("UPDATE diary_items SET snapshot = ?", "{}");
        },
      ],
      backupBeforeMigration,
      checkItems,
    ),
  ).rejects.toThrow(/Invalid diary portion/);
  expect(connection.get("PRAGMA user_version")?.user_version).toBe(currentVersion);
  expect(connection.all("PRAGMA table_info(diary_meals)").map((row) => row.name)).not.toContain(
    "memo",
  );
  expect(diary.getMeal(meal.id)).toEqual(editedMeal);
  const snapshotPath = source.snapshots[0];
  if (!snapshotPath) throw new Error("Expected a verified recovery snapshot");
  const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    await backup(snapshot, join(directory, "restored-active.db"));
  } finally {
    snapshot.close();
  }
  const restored = await createDatabase("restored-active.db").start();
  expect(restored.getMeal(meal.id)).toEqual(editedMeal);

  await migrateDiary(
    connection,
    [...diaryMigrations, (db) => db.exec("ALTER TABLE diary_meals ADD COLUMN memo TEXT")],
    backupBeforeMigration,
    checkItems,
  );
  expect(connection.get("PRAGMA user_version")?.user_version).toBe(currentVersion + 1);
  const migratedItem = decodeSnapshot(connection.get("SELECT snapshot FROM diary_items")?.snapshot);
  expect({ id: "item-drink", ...migratedItem }).toEqual(editedMeal.items[0]);
  source.db.close();

  const upgraded = createDatabase();
  await expect(upgraded.start()).rejects.toThrow(/newer version/);
  expect(upgraded.options.connection.get("PRAGMA user_version")?.user_version).toBe(
    currentVersion + 1,
  );
  expect(source.snapshots).toHaveLength(2);
  const priorSnapshot = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    expect(priorSnapshot.prepare("PRAGMA user_version").get()?.user_version).toBe(currentVersion);
    const previousItem = decodeSnapshot(
      priorSnapshot.prepare("SELECT snapshot FROM diary_items").get()?.snapshot,
    );
    expect({ id: "item-drink", ...previousItem }).toEqual(editedMeal.items[0]);
  } finally {
    priorSnapshot.close();
  }
});

test("rejects a silent incomplete backup and a stale copy with the correct version and row counts", async () => {
  const source = createDatabase();
  const store = await source.start();
  store.saveMeal(meal);
  const stale = createDatabase("stale.db");
  const staleStore = await stale.start();
  staleStore.saveMeal({
    ...meal,
    items: [
      createDiaryItem("item-drink", sourceFood, {
        amount: 25,
        unit: "ml",
      }),
    ],
  });
  const empty = createDatabase("incomplete.db");
  const steps = [
    ...diaryMigrations,
    (db: DiarySqliteConnection) => db.exec("ALTER TABLE diary_meals ADD COLUMN memo TEXT"),
  ];
  const backupAttempts: {
    backup: OpenDiaryOptions["backupBeforeMigration"];
    error: string;
  }[] = [
    { backup: async () => {}, error: "requires a verified backup" },
    {
      backup: async (_version, verify) => verify(empty.options.connection),
      error: "wrong storage version",
    },
    {
      backup: async (_version, verify) => verify(stale.options.connection),
      error: "does not match the current diary",
    },
  ];
  for (const attempt of backupAttempts) {
    await expect(
      migrateDiary(source.options.connection, steps, attempt.backup, () => {}),
    ).rejects.toThrow(attempt.error);
  }
  expect(source.options.connection.get("PRAGMA user_version")?.user_version).toBe(currentVersion);
  expect(
    source.options.connection.all("PRAGMA table_info(diary_meals)").map((row) => row.name),
  ).not.toContain("memo");
  expect(store.getMeal(meal.id)).toEqual(meal);
});

test("blocks reads and writes on an open handle after another connection upgrades the diary", async () => {
  const legacy = await createDatabase().start();
  legacy.saveMeal(meal);
  const upgraded = createDatabase();
  const { connection, backupBeforeMigration } = upgraded.options;
  await migrateDiary(
    connection,
    [
      ...diaryMigrations,
      (db) => {
        db.exec("ALTER TABLE diary_items ADD COLUMN memo TEXT");
        db.run("UPDATE diary_items SET memo = ? WHERE id = ?", "Retained note", "item-drink");
      },
    ],
    backupBeforeMigration,
    () => {},
  );

  expect(() => legacy.getMeal(meal.id)).toThrow(/version has changed/);
  expect(() => legacy.listMeals(meal.localDay)).toThrow(/version has changed/);
  expect(() => legacy.saveMeal({ ...meal, localDay: "2026-11-01" })).toThrow(/version has changed/);
  expect(() => legacy.deleteMeal(meal.id)).toThrow(/version has changed/);
  expect(() => legacy.sync.journal.history()).toThrow(/version has changed/);
  expect(() => legacy.sync.journal.requiredRelease()).toThrow(/version has changed/);
  expect(() => legacy.sync.journal.queued()).toThrow(/version has changed/);
  expect(() => legacy.sync.journal.serverCopy({ kind: "meal", id: meal.id })).toThrow(
    /version has changed/,
  );
  expect(() => legacy.listWeighIns(weighIn.localDay, weighIn.localDay)).toThrow(
    /version has changed/,
  );
  expect(() => legacy.saveWeighIn(weighIn)).toThrow(/version has changed/);
  expect(() => legacy.nutritionTargetAt(target.effectiveDay)).toThrow(/version has changed/);
  expect(() => legacy.saveNutritionTarget(target)).toThrow(/version has changed/);
  expect(connection.get("SELECT memo FROM diary_items WHERE id = ?", "item-drink")?.memo).toBe(
    "Retained note",
  );
  expect(connection.get("SELECT local_day FROM diary_meals WHERE id = ?", meal.id)?.local_day).toBe(
    meal.localDay,
  );
});

test("refuses to assume ownership of a populated, unversioned database", async () => {
  const source = createDatabase();
  source.db.exec("CREATE TABLE older_format (data); INSERT INTO older_format VALUES ('preserve')");
  await expect(source.start()).rejects.toThrow(/nonempty unversioned diary/);
  expect(source.options.connection.get("SELECT data FROM older_format")?.data).toBe("preserve");
  expect(source.options.connection.get("PRAGMA user_version")?.user_version).toBe(0);
});

const archiveCustomFood: Food = {
  ...sourceFood,
  id: { provider: "local", sourceId: "homemade-drink" },
  release: null,
  name: "Homemade drink",
};
const archiveRecipe = {
  id: "breakfast-drink",
  name: "Breakfast drink",
  ingredients: [
    createDiaryItem("recipe-item-drink", archiveCustomFood, { amount: 50, unit: "ml" }),
  ],
  servings: 2,
  cookedWeightG: 90,
};
const archiveTarget = {
  ...target,
  id: "second-target",
  configuredAt: target.configuredAt - 1000,
  target: manualNutritionTarget({ kcal: 1900, proteinG: 110, fatG: 60 }),
};

async function populatedPrivateArchive() {
  const diary = await createDatabase("archive-source.db").start();
  const item = meal.items[0];
  if (!item) throw new Error("The archive fixture needs a captured item");
  const captured = {
    ...meal,
    utcOffsetMinutes: -240,
    items: [{ ...item, nutrients: { ...item.nutrients, kcal: 79 } }],
  };
  diary.saveMeal(captured);
  diary.saveCustomFood(archiveCustomFood);
  diary.saveRecipe(archiveRecipe);
  const template = { id: "saved-night-meal", name: "Saved meal", items: captured.items };
  diary.saveMealTemplate(template);
  diary.setFavorite(sourceFood.id, true);
  diary.setFavorite(archiveCustomFood.id, true);
  diary.saveWeighIn(weighIn);
  diary.saveNutritionTarget(target);
  diary.saveNutritionTarget(archiveTarget);
  return { diary, captured, template, archive: diary.exportPrivateArchive() };
}

test("round-trips all private collections through a fresh SQLite diary and replays idempotently", async () => {
  const { archive, captured, template } = await populatedPrivateArchive();
  const json: Record<string, unknown> = JSON.parse(archive);
  expect(json).toMatchObject({ format: "edo-diary", formatVersion: 2 });
  expect(Object.keys(json)).toEqual([
    "format",
    "formatVersion",
    "meals",
    "customFoods",
    "recipes",
    "mealTemplates",
    "favorites",
    "weighIns",
    "nutritionTargets",
  ]);
  const destination = createDatabase("archive-destination.db");
  const restore = await destination.start();
  expect(restore.previewPrivateArchive(archive)).toEqual({
    newRecords: 9,
    alreadyPresent: 0,
    issues: [],
  });
  expect(restore.listCustomFoods()).toEqual([]);
  expect(restore.getMeal(captured.id)).toBeNull();
  expect(restore.restorePrivateArchive(archive)).toEqual({
    status: "restored",
    added: 9,
    alreadyPresent: 0,
  });
  expect(restore.getMeal(captured.id)).toEqual(captured);
  expect(restore.listCustomFoods()).toEqual([archiveCustomFood]);
  expect(restore.listRecipes()).toEqual([archiveRecipe]);
  expect(restore.listMealTemplates()).toEqual([template]);
  expect(restore.listFavorites()).toEqual([archiveCustomFood.id, sourceFood.id]);
  expect(restore.listWeighIns(weighIn.localDay, weighIn.localDay)).toEqual([weighIn]);
  expect(restore.nutritionTargetAt(target.effectiveDay)).toEqual(archiveTarget);
  expect(destination.db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
  expect(destination.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  destination.db.close();

  const reopened = await createDatabase("archive-destination.db").start();
  expect(reopened.exportPrivateArchive()).toBe(archive);
  expect(reopened.restorePrivateArchive(archive)).toEqual({
    status: "restored",
    added: 0,
    alreadyPresent: 9,
  });
  expect(reopened.nutritionTargetAt(target.effectiveDay)).toEqual(archiveTarget);
});

test("keeps legacy meal-only archives readable and does not touch other private collections", async () => {
  const legacy =
    '{"format":"edo-diary","formatVersion":1,"meals":[{"id":"legacy-meal","localDay":"2026-10-31","occurredAt":1793433600000,"items":[]}]}';
  const restore = await createDatabase("archive-destination.db").start();
  const initial = { ...weighIn, kg: 77 };
  restore.saveWeighIn(initial);
  expect(restore.previewPrivateArchive(legacy)).toEqual({
    newRecords: 1,
    alreadyPresent: 0,
    issues: [],
  });
  expect(restore.restorePrivateArchive(legacy)).toEqual({
    status: "restored",
    added: 1,
    alreadyPresent: 0,
  });
  expect(restore.listWeighIns(weighIn.localDay, weighIn.localDay)).toEqual([initial]);
  expect(restore.getMeal("legacy-meal")).toEqual({
    id: "legacy-meal",
    localDay: "2026-10-31",
    occurredAt: 1793433600000,
    items: [],
  });
  expect(restore.previewPrivateArchive(legacy)).toEqual({
    newRecords: 0,
    alreadyPresent: 1,
    issues: [],
  });
});

test("round-trips both saved offsets at a DST repeat, zero and an unknown offset", async () => {
  const source = await createDatabase("offset-source.db").start();
  const entries = [
    {
      id: "first",
      localDay: "2026-11-01",
      occurredAt: Date.parse("2026-11-01T05:30:00Z"),
      utcOffsetMinutes: -240,
      items: [],
    },
    {
      id: "second",
      localDay: "2026-11-01",
      occurredAt: Date.parse("2026-11-01T06:30:00Z"),
      utcOffsetMinutes: -300,
      items: [],
    },
    {
      id: "utc",
      localDay: "2026-11-01",
      occurredAt: Date.parse("2026-11-01T08:00:00Z"),
      utcOffsetMinutes: 0,
      items: [],
    },
    {
      id: "unknown",
      localDay: "2026-11-01",
      occurredAt: Date.parse("2026-11-01T09:00:00Z"),
      items: [],
    },
  ];
  for (const entry of entries) source.saveMeal(entry);
  const archive = source.exportPrivateArchive();
  const destination = await createDatabase("offset-destination.db").start();
  const invalid = JSON.stringify({
    ...JSON.parse(archive),
    meals: [{ ...entries[0], utcOffsetMinutes: null }],
  });
  expect(destination.previewPrivateArchive(invalid).issues).toEqual([
    { collection: "meals", index: 0, message: "Invalid diary archive UTC offset" },
  ]);
  expect(destination.restorePrivateArchive(invalid)).toMatchObject({ status: "rejected" });
  expect(destination.restorePrivateArchive(archive)).toMatchObject({ added: 4 });
  expect(destination.listMeals("2026-11-01")).toEqual(entries);
  expect(destination.exportPrivateArchive()).toBe(archive);
});

test("rejects an item ID used by a different meal without inserting any archive records", async () => {
  const { archive, captured } = await populatedPrivateArchive();
  const destination = await createDatabase("colliding-archive.db").start();
  const other = { ...captured, id: "unrelated-meal" };
  destination.saveMeal(other);
  const before = destination.exportPrivateArchive();
  expect(destination.restorePrivateArchive(archive)).toMatchObject({
    status: "rejected",
    preview: {
      issues: [
        {
          collection: "meals",
          index: 0,
          message: "An item ID is already used by another saved meal",
        },
      ],
    },
  });
  expect(destination.exportPrivateArchive()).toBe(before);
});

test("rejects unsupported sections, invalid values, and unknown fields inside private snapshots", async () => {
  const { archive } = await populatedPrivateArchive();
  const restore = await createDatabase("archive-destination.db").start();
  const saved = restore.exportPrivateArchive();
  const parsed: Record<string, unknown> = JSON.parse(archive);
  expect(() =>
    restore.previewPrivateArchive(JSON.stringify({ ...parsed, catalogCache: [] })),
  ).toThrow(/Unsupported diary archive field/);
  expect(() =>
    restore.previewPrivateArchive(JSON.stringify({ ...parsed, formatVersion: 99 })),
  ).toThrow(/Unsupported diary archive format/);
  expect(() => restore.previewPrivateArchive(JSON.stringify({ ...parsed, recipes: null }))).toThrow(
    /Invalid diary archive collection/,
  );
  const changed = JSON.stringify({
    ...parsed,
    recipes: [
      { ...archiveRecipe, ingredients: [{ ...archiveRecipe.ingredients[0], icon: "unsupported" }] },
    ],
    weighIns: [{ ...weighIn, kg: 0 }],
    nutritionTargets: [{ ...target, target: { ...target.target, availableCarbohydratesG: 0 } }],
    favorites: [sourceFood.id, sourceFood.id],
  });
  expect(restore.previewPrivateArchive(changed).issues).toEqual(
    expect.arrayContaining([
      { collection: "recipes", index: 0, message: "Unsupported diary archive field" },
      { collection: "weighIns", index: 0, message: "Invalid diary weigh-in weight" },
      {
        collection: "nutritionTargets",
        index: 0,
        message: "Carbohydrate target must fill the remaining energy budget",
      },
      { collection: "favorites", index: 1, message: "Duplicate ID in this archive collection" },
    ]),
  );
  expect(restore.restorePrivateArchive(changed)).toMatchObject({ status: "rejected" });
  expect(restore.exportPrivateArchive()).toBe(saved);
});

test("rechecks archive content after preview and keeps every local record on conflict", async () => {
  const { archive } = await populatedPrivateArchive();
  const restore = await createDatabase("archive-destination.db").start();
  expect(restore.previewPrivateArchive(archive).issues).toEqual([]);
  restore.saveCustomFood({ ...archiveCustomFood, name: "Edited on this device" });
  const saved = restore.exportPrivateArchive();
  expect(restore.restorePrivateArchive(archive)).toMatchObject({
    status: "rejected",
    preview: {
      issues: [
        { collection: "customFoods", index: 0, message: "This ID has different saved content" },
      ],
    },
  });
  expect(restore.exportPrivateArchive()).toBe(saved);
});

test("reports malformed archive JSON without including the input text", async () => {
  const diary = await createDatabase().start();
  const malformed = '{"meals":[example-private-text]}';
  expect(() => diary.previewPrivateArchive(malformed)).toThrow(/^Invalid diary archive JSON$/);
  expect(() => diary.restorePrivateArchive(malformed)).toThrow(/^Invalid diary archive JSON$/);
});

test("rolls back a failed archive across all tables and succeeds on retry", async () => {
  const { archive } = await populatedPrivateArchive();
  const destination = createDatabase("archive-destination.db");
  const restore = await destination.start();
  const saved = restore.exportPrivateArchive();
  destination.db.exec(`CREATE TRIGGER abort_archive BEFORE INSERT ON diary_targets
    WHEN NEW.id = 'second-target' BEGIN SELECT RAISE(ABORT, 'interrupted archive'); END`);
  expect(() => restore.restorePrivateArchive(archive)).toThrow(/interrupted archive/);
  expect(restore.exportPrivateArchive()).toBe(saved);
  destination.db.exec("DROP TRIGGER abort_archive");
  expect(restore.restorePrivateArchive(archive)).toEqual({
    status: "restored",
    added: 9,
    alreadyPresent: 0,
  });
});

test("preserves same-day target history and rejects ambiguous order on a populated device", async () => {
  const { archive } = await populatedPrivateArchive();
  const restore = await createDatabase("archive-destination.db").start();
  restore.saveNutritionTarget(archiveTarget);
  expect(restore.previewPrivateArchive(archive)).toMatchObject({
    issues: [
      {
        collection: "nutritionTargets",
        index: 0,
        message: "The saved targets have a different order on this day",
      },
    ],
  });
  expect(restore.restorePrivateArchive(archive)).toMatchObject({ status: "rejected" });
  expect(restore.getMeal(meal.id)).toBeNull();
  restore.saveNutritionTarget(target);
  expect(restore.restorePrivateArchive(archive)).toMatchObject({ status: "rejected" });
  expect(restore.nutritionTargetAt(target.effectiveDay)).toEqual(target);

  const prefix = await createDatabase("archive-prefix.db").start();
  prefix.saveNutritionTarget(target);
  expect(prefix.restorePrivateArchive(archive)).toEqual({
    status: "restored",
    added: 8,
    alreadyPresent: 1,
  });
  expect(prefix.nutritionTargetAt(target.effectiveDay)).toEqual(archiveTarget);
  const localNew = { ...target, id: "new-local-target" };
  prefix.saveNutritionTarget(localNew);
  expect(prefix.restorePrivateArchive(archive)).toEqual({
    status: "restored",
    added: 0,
    alreadyPresent: 9,
  });
  expect(prefix.nutritionTargetAt(target.effectiveDay)).toEqual(localNew);
});
