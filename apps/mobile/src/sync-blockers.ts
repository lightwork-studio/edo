import { type DiaryMeal, type openDiary, readMealSnapshot } from "@edo/storage";

type Diary = Awaited<ReturnType<typeof openDiary>>;
export type BlockerJournal = Pick<
  Diary["sync"]["journal"],
  "blockedRecordKeys" | "blockedReview" | "history"
>;
type Key = NonNullable<Parameters<BlockerJournal["blockedRecordKeys"]>[0]>;
type Review = NonNullable<ReturnType<BlockerJournal["blockedReview"]>>;
type AccountChange = NonNullable<Review["pulled"]>;
type Outcome = Review["blocked"]["result"];
type Reason =
  | Extract<Outcome, { status: "conflict" }>["reason"]
  | Extract<Outcome, { status: "rejected" }>["code"];

export type SyncBlocker = {
  readonly state: "blocked";
  readonly kind: Key["kind"];
  readonly reason: Reason;
  readonly operation: "put" | "delete";
  readonly next: Key | null;
  readonly weighIn?: {
    readonly phone: WeighInReviewSide;
    readonly account: WeighInReviewSide;
  };
  readonly meal?: {
    readonly phone: MealReviewSide;
    readonly account: MealReviewSide;
  };
};

type ReviewSide<T> =
  | ({ readonly state: "live" } & T)
  | { readonly state: "deleted" | "unavailable" | "unknown" };

export type WeighInReviewSide = ReviewSide<{
  readonly kg: number;
  readonly localDay: string;
  readonly occurredAt: number;
}>;

export type MealReviewSide = ReviewSide<{ readonly meal: Omit<DiaryMeal, "id"> }>;

export function formatReviewQuantity(amount: number, locale: string): string {
  const formatter = new Intl.NumberFormat(locale);
  const decimal = formatter.format(1.1).replaceAll(formatter.format(1), "") || ".";
  return amount.toString().replace(".", decimal);
}

function weighInValues(content: Record<string, unknown>, id: string): WeighInReviewSide {
  const { id: contentId, kg, localDay, occurredAt } = content;
  if (
    contentId !== id ||
    typeof kg !== "number" ||
    !Number.isFinite(kg) ||
    kg <= 0 ||
    typeof localDay !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(localDay) ||
    typeof occurredAt !== "number" ||
    !Number.isSafeInteger(occurredAt) ||
    !Number.isFinite(new Date(occurredAt).getTime())
  ) {
    return { state: "unavailable" };
  }
  const day = new Date(`${localDay}T00:00:00.000Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== localDay) {
    return { state: "unavailable" };
  }
  return { state: "live", kg, localDay, occurredAt };
}

function mealValues(content: Record<string, unknown>, id: string): MealReviewSide {
  if (content.id !== id) return { state: "unavailable" };
  try {
    const { id: _mealId, ...meal } = readMealSnapshot(content);
    return { state: "live", meal };
  } catch {
    return { state: "unavailable" };
  }
}

function latestAccountSide<T>(
  review: Review,
  key: Key,
  decode: (content: Record<string, unknown>, id: string) => ReviewSide<T>,
): ReviewSide<T> {
  function read(change: AccountChange): ReviewSide<T> {
    if (change.kind !== key.kind || change.id !== key.id) return { state: "unavailable" };
    return change.state === "live" ? decode(change.content, key.id) : { state: change.state };
  }

  const { result } = review.blocked;
  const reported = result.status === "conflict" ? result.current : null;
  const { pulled } = review;
  const latest = !reported || (pulled && pulled.revision >= reported.revision) ? pulled : reported;
  if (!latest || latest.revision < (review.baseRevision ?? 0)) return { state: "unknown" };
  const other = latest === pulled ? reported : pulled;
  const side = read(latest);
  if (side.state === "live" && other?.state === "deleted") return { state: "unavailable" };
  if (other?.revision !== latest.revision) return side;
  // A complete authenticated copy can fill an omitted body at the same revision.
  if (latest.state === "unavailable" && other.state === "live") return read(other);
  if (other.state === "unavailable" && side.state === "live") return side;
  if (JSON.stringify(side) !== JSON.stringify(read(other))) {
    return { state: "unavailable" };
  }
  return side;
}

export function syncBlockerNotice(journal: BlockerJournal): "blocked" | "clear" | "error" {
  try {
    if (!journal.history()) return "clear";
    return journal.blockedRecordKeys(null, 1).keys.length ? "blocked" : "clear";
  } catch {
    return "error";
  }
}

export function readSyncBlocker(
  journal: BlockerJournal,
  after: Key | null,
): SyncBlocker | { readonly state: "empty" | "changed" | "error"; readonly next: Key | null } {
  let next: Key | null = null;
  try {
    const page = journal.blockedRecordKeys(after, 1);
    next = page.next;
    const key = page.keys[0];
    if (!key) return { state: after === null ? "empty" : "changed", next };
    const review = journal.blockedReview(key);
    if (!review) return { state: "changed", next };
    const result = review.blocked.result;
    const { device } = review;
    return {
      state: "blocked",
      kind: key.kind,
      reason: result.status === "conflict" ? result.reason : result.code,
      operation: device.op,
      next,
      ...(key.kind === "weigh-in" && {
        weighIn: {
          phone: device.op === "put" ? weighInValues(device.content, key.id) : { state: "deleted" },
          account: latestAccountSide(review, key, weighInValues),
        },
      }),
      ...(key.kind === "meal" && {
        meal: {
          phone: device.op === "put" ? mealValues(device.content, key.id) : { state: "deleted" },
          account: latestAccountSide(review, key, mealValues),
        },
      }),
    };
  } catch {
    return { state: "error", next };
  }
}
