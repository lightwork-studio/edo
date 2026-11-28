# Account sync client candidate

`createSyncClient` negotiates against an explicit server URL and captures that connection's
credentials in memory. Reconnecting replaces the active connection. Late responses from the
superseded connection are rejected. The saved server URL, account binding, lineage and observed revision fence reconnections for an existing diary. HTTPS is required for remote servers.

`installSyncJournal` creates the candidate journal tables on the diary's SQLite connection.
The owning diary migration calls it before opening the journal. A caller binds an authenticated
account, then supplies its existing record writer as `commitLocal`'s callback. This stores the
record change and its pending intent in one transaction. `prepare` persists the exact in-flight
submission and its protocol release before any network request. Callers use `requiredRelease`
to reconnect while that receipt is outstanding. An acknowledgement advances the edit's base revision and
retains a newer pending local edit. Downloaded records, remote copies and the pull cursor commit
in their own transaction. If a newer server copy arrives while an attempt is pending, the journal
keeps it separately. The final acknowledgement applies that copy with the diary update when the
last local edit clears.

A stale or rejected mutation remains queued with its server evidence. A caller pulls the current
copy before offering review. `retryReviewed` checks that revision against the stored server copy
and gives the chosen local draft a fresh submission ID. The app can re-add a favourite
after the user reviews its deletion. Other deleted records need a new ID. The app needs
the attached-account flow and grouped conflict review before it can offer this candidate to users.
