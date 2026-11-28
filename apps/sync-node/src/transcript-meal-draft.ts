import { addAbortListener } from "node:events";
import type { BlsSearchLanguage, CatalogDatabase } from "@edo/catalog-import/bls-search";
import {
  type BlsMealDraftItem,
  maxDraftItems,
  readDraftFields,
  resolveBlsMealDraft,
} from "./bls-meal-draft.ts";

const maxTranscriptBytes = 4096;
const draftTimeoutMs = 10_000;

type TranscriptExtraction = (input: {
  readonly transcript: string;
  readonly language: BlsSearchLanguage;
  readonly signal: AbortSignal;
}) => Promise<unknown>;

/** Start and exclusive end are UTF-16 offsets in the submitted transcript. */
type TranscriptPhrase = { readonly start: number; readonly end: number };
type TranscriptDraft =
  | { readonly state: "ready"; readonly items: readonly TranscriptDraftItem[] }
  | { readonly state: "canceled" | "timed-out" | "unavailable" };

type TranscriptDraftItem = BlsMealDraftItem & { readonly phrase: TranscriptPhrase | null };

type TranscriptInput = { transcript: string; language: BlsSearchLanguage };

function readTranscript(input: unknown): TranscriptInput {
  const { transcript, language } = readDraftFields(input, ["transcript", "language"]);
  if (
    (language !== "en" && language !== "de") ||
    typeof transcript !== "string" ||
    transcript.length > maxTranscriptBytes ||
    Buffer.byteLength(transcript, "utf8") > maxTranscriptBytes ||
    !transcript.trim() ||
    /[\uD800-\uDFFF]/u.test(transcript) ||
    /\p{Cc}/u.test(transcript.replaceAll(/[\t\r\n]/g, ""))
  ) {
    throw new TypeError("Invalid meal transcript");
  }
  return { transcript, language };
}

function findPhrase(
  transcript: string,
  boundaries: ReadonlySet<number>,
  quote: unknown,
): TranscriptPhrase | null {
  if (quote === null) return null;
  if (typeof quote !== "string") throw new TypeError("Invalid extracted meal quote");
  if (quote.length > transcript.length || !quote.trim()) return null;
  let match: TranscriptPhrase | null = null;
  for (const start of boundaries) {
    const end = start + quote.length;
    if (!boundaries.has(end) || !transcript.startsWith(quote, start)) continue;
    if (match) return null;
    match = { start, end };
  }
  return match;
}

function readExtraction(output: unknown, { transcript, language }: TranscriptInput) {
  if (!Array.isArray(output)) throw new TypeError("Invalid extracted meal batch");
  const { length } = output;
  if (length > maxDraftItems) throw new TypeError("Invalid extracted meal batch");
  const boundaries = new Set([transcript.length]);
  for (const { index } of new Intl.Segmenter(language, { granularity: "word" }).segment(
    transcript,
  )) {
    boundaries.add(index);
  }
  const captured = Array.from({ length }, (_, index) => {
    const { quote, name, portion, confidence } = readDraftFields(output[index], [
      "quote",
      "name",
      "portion",
      "confidence",
    ]);
    return {
      phrase: findPhrase(transcript, boundaries, quote),
      item: { name, portion, confidence },
    };
  });
  return captured.map((entry) => {
    const { phrase } = entry;
    if (!phrase) return entry;
    const overlaps = captured.some(
      (other) =>
        other !== entry &&
        other.phrase &&
        phrase.start < other.phrase.end &&
        other.phrase.start < phrase.end,
    );
    return overlaps ? { ...entry, phrase: null } : entry;
  });
}

/** Prepare a draft for review in memory without retrying extraction or saving the transcript. */
export async function draftFromTranscript(
  db: CatalogDatabase,
  extract: TranscriptExtraction,
  input: unknown,
  requestSignal?: AbortSignal,
): Promise<TranscriptDraft> {
  return runDraft(db, extract, readTranscript(input), requestSignal);
}

async function runDraft(
  db: CatalogDatabase,
  extract: TranscriptExtraction,
  source: TranscriptInput,
  requestSignal?: AbortSignal,
): Promise<TranscriptDraft> {
  if (requestSignal?.aborted) return { state: "canceled" };

  const deadline = new AbortController();
  const expiresAt = performance.now() + draftTimeoutMs;
  const timer = setTimeout(() => deadline.abort(), draftTimeoutMs);
  const signal = requestSignal
    ? AbortSignal.any([requestSignal, deadline.signal])
    : deadline.signal;
  function stopped(): TranscriptDraft {
    return {
      state:
        deadline.signal.aborted && signal.reason === deadline.signal.reason
          ? "timed-out"
          : "canceled",
    };
  }
  function interrupted(): boolean {
    // Promise reactions can run before an expired timer gets a chance to fire.
    if (!signal.aborted && performance.now() >= expiresAt) deadline.abort();
    return signal.aborted;
  }

  const stop = Symbol("draft interruption");
  let listener: Disposable | undefined;
  const interruption = new Promise<typeof stop>((resolve) => {
    listener = addAbortListener(signal, () => resolve(stop));
  });
  try {
    let output = await Promise.race([extract({ ...source, signal }), interruption]);
    if (output === stop || interrupted()) return stopped();
    const captured = readExtraction(output, source);
    // Once spans have been calculated, a pending catalog read needs only the extracted items.
    source.transcript = "";
    output = undefined;
    if (interrupted()) return stopped();
    const matches = await Promise.race([
      resolveBlsMealDraft(
        db,
        captured.map(({ item }) => item),
        source.language,
      ),
      interruption,
    ]);
    if (matches === stop || interrupted()) return stopped();
    return {
      state: "ready",
      items: matches.map((item, index) => ({ ...item, phrase: captured[index]?.phrase ?? null })),
    };
  } catch {
    return interrupted() ? stopped() : { state: "unavailable" };
  } finally {
    source.transcript = "";
    clearTimeout(timer);
    listener?.[Symbol.dispose]();
  }
}
