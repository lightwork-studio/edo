import type { openDiary } from "@edo/storage";

type Diary = Awaited<ReturnType<typeof openDiary>>;
export type BlockerJournal = Pick<
  Diary["sync"]["journal"],
  "blockedRecords" | "blockedReview" | "history"
>;
type Key = NonNullable<Parameters<BlockerJournal["blockedRecords"]>[0]>;
type Outcome = NonNullable<ReturnType<BlockerJournal["blockedReview"]>>["blocked"]["result"];
type Reason =
  | Extract<Outcome, { status: "conflict" }>["reason"]
  | Extract<Outcome, { status: "rejected" }>["code"];

export type SyncBlocker = {
  readonly state: "blocked";
  readonly kind: Key["kind"];
  readonly reason: Reason;
  readonly operation: "put" | "delete";
  readonly next: Key | null;
};

export function syncBlockerNotice(journal: BlockerJournal): "blocked" | "clear" | "error" {
  try {
    if (!journal.history()) return "clear";
    return journal.blockedRecords(null, 1).records.length ? "blocked" : "clear";
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
    const page = journal.blockedRecords(after, 1);
    next = page.next;
    const entry = page.records[0];
    if (!entry) return { state: after === null ? "empty" : "changed", next };
    const review = journal.blockedReview(entry.key);
    if (!review) return { state: "changed", next };
    const result = review.blocked.result;
    return {
      state: "blocked",
      kind: entry.key.kind,
      reason: result.status === "conflict" ? result.reason : result.code,
      operation: review.device.op,
      next,
    };
  } catch {
    return { state: "error", next };
  }
}
