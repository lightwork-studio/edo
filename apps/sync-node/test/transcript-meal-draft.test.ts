import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { CatalogDatabase } from "@edo/catalog-import/bls-search";
import { expect, test, vi } from "vitest";
import { draftFromTranscript } from "../src/transcript-meal-draft.ts";

const seedPath = fileURLToPath(new URL("../../mobile/assets/bls.sqlite", import.meta.url));
const input = { language: "en", transcript: "🥣 Apple pie sand batter and an apple, plus apple" };
const englishItem = {
  name: "Apple pie sand batter",
  quote: "Apple pie sand batter",
  portion: { amount: 125.5, unit: "g", quality: "stated" },
  confidence: 0.86,
};
const emptyCatalog: CatalogDatabase = {
  async getAllAsync() {
    throw new Error("Unexpected catalog access");
  },
};

function deferredExtraction() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("links unique verbatim English and German phrases to shipped bilingual BLS choices", async () => {
  using db = new DatabaseSync(seedPath, { readOnly: true });
  const catalog: CatalogDatabase = {
    async getAllAsync<T>(sql: string, parameter: string): Promise<T[]> {
      return db.prepare(sql).all(parameter) as T[];
    },
  };
  const english = await draftFromTranscript(
    catalog,
    async ({ transcript, language, signal }) => {
      expect(transcript).toBe(input.transcript);
      expect(language).toBe("en");
      expect(signal.aborted).toBe(false);
      return [
        englishItem,
        { ...englishItem, name: "Apple", quote: "apple", portion: null },
        { ...englishItem, name: "Zirkonquarzphantasiesuppe", quote: "invented words" },
      ];
    },
    input,
  );
  expect(english).toMatchObject({
    state: "ready",
    items: [
      {
        name: englishItem.name,
        phrase: { start: 3, end: 24 },
        portion: englishItem.portion,
        catalog: {
          state: "matches",
          choices: [{ name: "Apple pie (sand cake batter)", id: { sourceId: "D130100" } }],
        },
      },
      { name: "Apple", phrase: null, portion: null },
      { phrase: null, catalog: { state: "no-match" } },
    ],
  });

  const german = " Apfelkuchen Sandmasse, dazu Wasser\n";
  const estimate = { amount: 0.5, unit: "portion", quality: "estimated" };
  const extract = vi.fn(async () => [
    {
      name: "Apfelkuchen Sandmasse",
      quote: "Apfelkuchen Sandmasse",
      portion: estimate,
      confidence: null,
    },
  ]);
  await expect(
    draftFromTranscript(catalog, extract, { language: "de", transcript: german }),
  ).resolves.toMatchObject({
    state: "ready",
    items: [
      {
        phrase: { start: 1, end: 22 },
        portion: estimate,
        confidence: null,
        catalog: { state: "matches", choices: [{ name: "Apfelkuchen (Sandmasse)" }] },
      },
    ],
  });
  expect(extract).toHaveBeenCalledWith({
    language: "de",
    transcript: german,
    signal: expect.any(AbortSignal),
  });
});

test("validates the original UTF-8 bytes before invoking the extractor", async () => {
  const extract = vi.fn(async () => []);
  for (const body of [
    { ...input, language: "unknown" },
    { ...input, transcript: "  \n\t" },
    { ...input, transcript: "ä".repeat(2049) },
    { ...input, transcript: "food\u0000" },
    { ...input, transcript: "food\ud800" },
    { ...input, additionalField: input.transcript },
  ]) {
    await expect(draftFromTranscript(emptyCatalog, extract, body)).rejects.toBeInstanceOf(
      TypeError,
    );
  }
  expect(extract).not.toHaveBeenCalled();
  await expect(
    draftFromTranscript(emptyCatalog, extract, { ...input, transcript: "ä".repeat(2048) }),
  ).resolves.toEqual({ state: "ready", items: [] });
  expect(extract).toHaveBeenCalledOnce();
});

test("reports dependency failure without returning its details or looking up a partial batch", async () => {
  const getAllAsync = vi.fn(async () => []);
  const catalog = { getAllAsync };
  for (const output of [
    [englishItem, { ...englishItem, confidence: 1.5 }],
    Array.from({ length: 17 }, () => englishItem),
    [englishItem, { ...englishItem, extra: true }],
    { items: [englishItem] },
  ]) {
    await expect(draftFromTranscript(catalog, async () => output, input)).resolves.toEqual({
      state: "unavailable",
    });
  }
  const failed = vi.fn(async () => {
    throw new Error(input.transcript);
  });
  await expect(draftFromTranscript(catalog, failed, input)).resolves.toEqual({
    state: "unavailable",
  });
  expect(failed).toHaveBeenCalledOnce();
  expect(getAllAsync).not.toHaveBeenCalled();
});

test("cancels before extraction or while awaiting it and ignores a late result", async () => {
  const stop = new AbortController();
  const getAllAsync = vi.fn(async () => []);
  const catalog = { getAllAsync };
  const output = deferredExtraction();
  let sentSignal: AbortSignal | undefined;
  const extract = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
    sentSignal = signal;
    return output.promise;
  });
  const pending = draftFromTranscript(catalog, extract, input, stop.signal);
  stop.abort();
  await expect(pending).resolves.toEqual({ state: "canceled" });
  expect(sentSignal?.aborted).toBe(true);
  output.resolve([englishItem]);
  await expect(draftFromTranscript(catalog, extract, input, stop.signal)).resolves.toEqual({
    state: "canceled",
  });
  expect(extract).toHaveBeenCalledOnce();
  expect(getAllAsync).not.toHaveBeenCalled();
});

test("bounds an unresponsive extractor and never retries or starts catalog work", async () => {
  vi.useFakeTimers();
  try {
    const getAllAsync = vi.fn(async () => []);
    const catalog = { getAllAsync };
    const output = deferredExtraction();
    let sentSignal: AbortSignal | undefined;
    const extract = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      sentSignal = signal;
      return output.promise;
    });
    const pending = draftFromTranscript(catalog, extract, input);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({ state: "timed-out" });
    expect(sentSignal?.aborted).toBe(true);
    output.resolve([englishItem]);
    await vi.advanceTimersByTimeAsync(0);
    expect(extract).toHaveBeenCalledOnce();
    expect(getAllAsync).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("links whole phrases without overlapping, repeated, or split Unicode spans", async () => {
  const transcript = "🍎 Apfel, danach ein pineapple, Mu\u0308sli und zwei Bananen, plus Tee.";
  const item = (name: string, quote: string) => ({ name, quote, portion: null, confidence: 0.5 });
  const catalog = { getAllAsync: vi.fn(async () => []) };
  const candidates = [
    item("Apfel", "Apfel"),
    item("Apple", "apple"),
    item("Müsli", "Mu"),
    item("Müsli", "Mu\u0308sli"),
    item("Banane", "zwei Bananen"),
    item("Banane", "Bananen"),
    item("Tee", "Tee"),
    item("Tee", "Tee"),
  ];
  const draft = await draftFromTranscript(catalog, async () => candidates, {
    language: "de",
    transcript,
  });
  expect(draft.state).toBe("ready");
  if (draft.state !== "ready") throw new Error("Draft unavailable");
  expect(
    draft.items.map(({ phrase }) => phrase && transcript.slice(phrase.start, phrase.end)),
  ).toEqual(["Apfel", null, null, "Mu\u0308sli", null, null, null, null]);
  expect(draft.items[0]?.phrase).toEqual({ start: 3, end: 8 });
});

test("checks the elapsed deadline before querying BLS even if the timer has not run", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  try {
    const getAllAsync = vi.fn(async () => []);
    await expect(
      draftFromTranscript(
        { getAllAsync },
        async () => {
          clock.mockReturnValue(10_001);
          return [englishItem];
        },
        input,
      ),
    ).resolves.toEqual({ state: "timed-out" });
    expect(getAllAsync).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});

test("discards a catalog result that completes after the elapsed deadline", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  try {
    const getAllAsync = vi.fn(async () => {
      clock.mockReturnValue(10_001);
      return [];
    });
    await expect(
      draftFromTranscript({ getAllAsync }, async () => [englishItem], input),
    ).resolves.toEqual({ state: "timed-out" });
    expect(getAllAsync).toHaveBeenCalledOnce();
  } finally {
    clock.mockRestore();
  }
});
