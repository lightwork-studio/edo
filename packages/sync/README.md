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
the edit's base revision and retains a newer pending local edit. Downloaded records, remote
copies and the pull cursor commit in one transaction. The journal keeps a newer server copy
separately while a local attempt is pending. The final acknowledgement applies that copy
with the diary update when the last local edit clears.

A stale or rejected mutation remains queued with its server evidence. A caller pulls the current
copy before offering review. `retryReviewed` verifies both the reviewed server revision
and the reviewed local draft before assigning a fresh submission ID. The app can re-add a favourite
after the user reviews its deletion. Other deleted records need a new ID. The app needs
the attached-account flow and grouped conflict review before it can offer this candidate to users.
