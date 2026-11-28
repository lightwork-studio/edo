import type { openDiary } from "@edo/storage";

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
};

export type WeighInReviewSide =
  | {
      readonly state: "live";
      readonly kg: number;
      readonly localDay: string;
      readonly occurredAt: number;
    }
  | { readonly state: "deleted" | "unavailable" | "unknown" };

export function formatWeighInKilograms(kg: number, locale: string): string {
  const formatter = new Intl.NumberFormat(locale);
  const decimal = formatter.format(1.1).replaceAll(formatter.format(1), "") || ".";
  return kg.toString().replace(".", decimal);
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

function accountWeighIn(change: AccountChange, id: string): WeighInReviewSide {
  if (change.kind !== "weigh-in" || change.id !== id) return { state: "unavailable" };
  return change.state === "live" ? weighInValues(change.content, id) : { state: change.state };
}

function latestAccountWeighIn(review: Review, id: string): WeighInReviewSide {
  const { result } = review.blocked;
  const reported = result.status === "conflict" ? result.current : null;
  const { pulled } = review;
  const latest = !reported || (pulled && pulled.revision >= reported.revision) ? pulled : reported;
  if (!latest || latest.revision < (review.baseRevision ?? 0)) return { state: "unknown" };
  const other = latest === pulled ? reported : pulled;
  const side = accountWeighIn(latest, id);
  if (side.state === "live" && other?.state === "deleted") return { state: "unavailable" };
  if (other?.revision !== latest.revision) return side;
  // A complete authenticated copy can fill an omitted body at the same revision.
  if (latest.state === "unavailable" && other.state === "live") return accountWeighIn(other, id);
  if (other.state === "unavailable" && side.state === "live") return side;
  if (JSON.stringify(side) !== JSON.stringify(accountWeighIn(other, id))) {
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
          account: latestAccountWeighIn(review, key.id),
        },
      }),
    };
  } catch {
    return { state: "error", next };
  }
}
