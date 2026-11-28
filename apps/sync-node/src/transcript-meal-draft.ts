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

function readTranscript(input: unknown): { transcript: string; language: BlsSearchLanguage } {
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

function findPhrase(transcript: string, quote: unknown): TranscriptPhrase | null {
  if (
    typeof quote !== "string" ||
    quote.length > transcript.length ||
    !quote.trim() ||
    /[\uD800-\uDFFF]/u.test(quote)
  ) {
    return null;
  }
  const start = transcript.indexOf(quote);
  if (start < 0 || transcript.indexOf(quote, start + 1) !== -1) return null;
  return { start, end: start + quote.length };
}

async function buildDraft(
  db: CatalogDatabase,
  extract: TranscriptExtraction,
  { transcript, language }: ReturnType<typeof readTranscript>,
  signal: AbortSignal,
): Promise<TranscriptDraft> {
  const output = await extract({ transcript, language, signal });
  signal.throwIfAborted();
  if (!Array.isArray(output)) throw new TypeError("Invalid extracted meal batch");
  const { length } = output;
  if (length > maxDraftItems) throw new TypeError("Invalid extracted meal batch");
  const captured = Array.from({ length }, (_, index) => {
    const { quote, name, portion, confidence } = readDraftFields(output[index], [
      "quote",
      "name",
      "portion",
      "confidence",
    ]);
    return { phrase: findPhrase(transcript, quote), item: { name, portion, confidence } };
  });
  signal.throwIfAborted();
  const matches = await resolveBlsMealDraft(
    db,
    captured.map(({ item }) => item),
    language,
  );
  return {
    state: "ready",
    items: matches.map((item, index) => ({ ...item, phrase: captured[index]?.phrase ?? null })),
  };
}

/** Prepare a draft for review in memory without retrying extraction or saving the transcript. */
export async function draftFromTranscript(
  db: CatalogDatabase,
  extract: TranscriptExtraction,
  input: unknown,
  requestSignal?: AbortSignal,
): Promise<TranscriptDraft> {
  const source = readTranscript(input);
  if (requestSignal?.aborted) return { state: "canceled" };

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), draftTimeoutMs);
  const signal = requestSignal
    ? AbortSignal.any([requestSignal, deadline.signal])
    : deadline.signal;
  function stopped(): TranscriptDraft {
    return { state: deadline.signal.aborted ? "timed-out" : "canceled" };
  }

  let listener: Disposable | undefined;
  const interruption = new Promise<TranscriptDraft>((resolve) => {
    listener = addAbortListener(signal, () => resolve(stopped()));
  });
  try {
    const draft = await Promise.race([interruption, buildDraft(db, extract, source, signal)]);
    return signal.aborted ? stopped() : draft;
  } catch {
    return signal.aborted ? stopped() : { state: "unavailable" };
  } finally {
    clearTimeout(timer);
    listener?.[Symbol.dispose]();
  }
}
