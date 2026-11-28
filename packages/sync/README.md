# Account sync client candidate

`createSyncClient` negotiates against an explicit server URL and captures that connection's
credentials in memory. Reconnecting replaces the active connection. Late responses from the
superseded connection are rejected. The saved server URL, account binding, lineage and observed revision fence reconnections for an existing diary. HTTPS is required for remote servers.

`installSyncJournal` creates the candidate journal tables on the diary's SQLite connection.
The owning diary migration calls it before opening the journal. The journal binds to a
session issued by the client and derives the server URL from that session. A caller
supplies a synchronous transaction-body writer on the same connection as `commitLocal`'s
callback. This stores the record change and its pending intent in one transaction.
`prepare` builds a batch within the transport byte limit and persists the exact in-flight
submissions and release before a network request. Oversized edits stay pending for
correction. Callers use `requiredRelease` to reconnect while a receipt is outstanding.

Apply replies through the client session that requested them. An acknowledgement advances
the exact submitted edit's base revision and retains a newer pending local edit. Downloaded records, remote
copies and the pull cursor commit in one transaction. The journal keeps a newer server copy
separately while a local attempt is pending. The final acknowledgement applies that copy
with the diary update when the last local edit clears.

A stale or rejected mutation remains queued with its server evidence. A caller pulls the current
copy before offering review. List refusals through `blockedRecords`, which returns record keys
and statuses in pages. Open the selected record with `blockedReview` to read its current values.
Pass the immutable snapshot from `blockedReview` back to
`retryReviewed` on the same journal. It rechecks the binding and all displayed evidence before
assigning a fresh submission ID.
If the evidence changed, open a fresh review. The journal reserves
previous draft IDs so later edits cannot reuse them. The app can re-add a favourite
after the user reviews its deletion. Other deleted records need a new ID. The app needs
the attached-account flow and grouped conflict review before it can offer this candidate to users.

The diary candidate's grouped meal path stages each authenticated pull and applies dependent meal
updates together once its cursor catches up. Item IDs observed in a superseded pull, a conflict
receipt or a local edit remain available to the grouping decision. Unresolved prior membership
can defer changes to item ownership. The path applies independent weigh-ins when the local
record can safely advance. Other record kinds retain their staged copies. Grouped meal receipts
commit independently of replay, so the caller can retry an interrupted replay after reopening.
