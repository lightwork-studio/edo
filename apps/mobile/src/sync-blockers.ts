import type { openDiary } from "@edo/storage";

type Diary = Awaited<ReturnType<typeof openDiary>>;
export type BlockerJournal = Pick<
  Diary["sync"]["journal"],
  "blockedRecordKeys" | "blockedReview" | "history"
>;
type Key = NonNullable<Parameters<BlockerJournal["blockedRecordKeys"]>[0]>;
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
    return {
      state: "blocked",
      kind: key.kind,
      reason: result.status === "conflict" ? result.reason : result.code,
      operation: review.device.op,
      next,
    };
  } catch {
    return { state: "error", next };
  }
}
