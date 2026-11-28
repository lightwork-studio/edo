import {
  type BlsSearchLanguage,
  type CatalogDatabase,
  searchBls,
} from "@edo/catalog-import/bls-search";
import type { Food, Portion } from "@edo/core";

export const maxDraftItems = 16;
const maxNameLength = 160;
const maxChoices = 5;

type DraftPortion = Portion & { readonly quality: "stated" | "estimated" };

interface DraftItem {
  readonly name: string;
  readonly portion: DraftPortion | null;
  readonly confidence: number | null;
}

type CatalogMatch =
  | { readonly state: "matches"; readonly choices: readonly Food[]; readonly hasMore: boolean }
  | { readonly state: "no-match" }
  | { readonly state: "unavailable" };

export interface BlsMealDraftItem extends DraftItem {
  readonly catalog: CatalogMatch;
}

export function readDraftFields(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid extracted meal draft");
  }
  if (
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  ) {
    throw new TypeError("Invalid extracted meal draft");
  }
  return value as Record<string, unknown>;
}

function readPortion(value: unknown): DraftPortion | null {
  if (value === null) return null;
  const { amount, unit, quality } = readDraftFields(value, ["amount", "unit", "quality"]);
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    (unit !== "g" && unit !== "ml" && unit !== "portion") ||
    (quality !== "stated" && quality !== "estimated")
  ) {
    throw new TypeError("Invalid extracted meal portion");
  }
  return { amount, unit, quality };
}

function readItem(value: unknown): DraftItem {
  const { name, portion, confidence } = readDraftFields(value, ["name", "portion", "confidence"]);
  if (
    typeof name !== "string" ||
    name.length > maxNameLength ||
    !name.trim() ||
    name.includes("\0") ||
    /[\uD800-\uDFFF]/u.test(name)
  ) {
    throw new TypeError("Invalid extracted meal food name");
  }
  if (
    confidence !== null &&
    (typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1)
  ) {
    throw new TypeError("Invalid extracted meal confidence");
  }
  return { name: name.trim(), portion: readPortion(portion), confidence };
}

async function catalogMatch(
  db: CatalogDatabase,
  name: string,
  language: BlsSearchLanguage,
): Promise<CatalogMatch> {
  try {
    const choices = await searchBls(db, name, language);
    return choices.length
      ? {
          state: "matches",
          choices: choices.slice(0, maxChoices),
          hasMore: choices.length > maxChoices,
        }
      : { state: "no-match" };
  } catch {
    return { state: "unavailable" };
  }
}

/** Resolve structured extraction to BLS choices for review without changing any diary records. */
export async function resolveBlsMealDraft(
  db: CatalogDatabase,
  extraction: unknown,
  language: BlsSearchLanguage,
): Promise<BlsMealDraftItem[]> {
  if (!Array.isArray(extraction)) {
    throw new TypeError("Invalid extracted meal batch");
  }
  const { length } = extraction;
  if (length > maxDraftItems) throw new TypeError("Invalid extracted meal batch");
  // Validate the entire batch before a malformed item can initiate any catalog work.
  const items = Array.from({ length }, (_, index) => readItem(extraction[index]));
  return Promise.all(
    items.map(async (item) => ({ ...item, catalog: await catalogMatch(db, item.name, language) })),
  );
}
