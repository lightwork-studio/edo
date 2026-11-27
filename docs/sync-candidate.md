# First-party sync protocol candidate

Edo uses the same protocol with a managed server and a self-hosted server. This draft uses release `0.1` while the app and server compatibility behavior is being verified. The public catalog has its own release channels. User-authorized developer access belongs to the separate MCP surface.

## Connection and writes

| Request            | Candidate behavior                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /sync/hello` | An authenticated device advertises releases and capabilities. The server picks a mutually supported release and returns the agreed features, the authenticated account binding, the account history lineage, and its current revision. If the account was restored, the server can also report the source lineage and backup revision.                                     |
| `POST /sync/push`  | The request names the negotiated release, current lineage, and ordered submissions. Each submission carries a stable `submissionId`, record kind and ID, and the base revision it observed. A put also carries its versioned record content.                                                                                                                               |
| `POST /sync/pull`  | The device asks for changes after its saved cursor on that lineage. The response gives an ordered page, the next cursor and a signal when more pages remain. The app commits the page and cursor together. Each page reports the current form of records changed since the cursor. Superseded versions can leave gaps. The next cursor equals the last delivered revision. |

The service obtains the account from the credential used for the request. The app checks the account binding saved for this diary and the lineage and last observed revision before replaying work. A changed binding, changed lineage or lower revision stops uploads until the app downloads the new history and reconciles it against the local diary and outbox. A download cursor belongs to one account history.

Local edits remain usable during a connection failure. The local diary write and its outbox entry belong to one SQLite transaction. Every retry uses the original submission ID for the same intent. A successful reply assigns a revision, and another copy of that reply can be processed safely. A stale, deleted, or already-existing record returns the current server revision and the retained value when it is available. Rejected submissions require a visible action, and retryable ones keep their queue position and data.

## Records and old clients

A meal and a recipe each travel as one record. Nested item IDs let an app compare its original, local, and server copies. The quantity and nutrition captured for an item move together. The other records carry custom foods, meal templates, favourites, nutrition targets and weigh-ins. A favourite has a canonical JSON pair of provider and source ID as its record identity. Public catalog lookups and private captured values can therefore evolve independently.

An older decoder retains unknown JSON fields and opaque record kinds when reading newer data. For a write, the server must preserve fields outside the writer's release. The version-specific application layer owns that merge, including nested items identified by ID. Only kinds defined in the negotiated release may be submitted. A peer with no compatible release or without the `write-records` feature keeps its local queue and reports an action the user can take.

The server compares and allocates the new revision in the same transaction that stores an accepted record or tombstone and its receipt. For a normal stale write, the device may automatically rebase independent fields. An edit against a deletion or two edits of the same field need grouped review. The next submission uses the latest revision observed during review, so another device's intervening write triggers a new check.

## Before publishing a release

Exercise the app and server with the same release, a previous client against a newer server, and a client that has no common release. Include lost responses, interrupted pages, deletions, change receipts, stale writes, older backups, and server moves. Confirm that older-client edits preserve unknown fields when the server stores them. Use synthetic fixtures and keep those fixtures fixed after publication.

The account credential and pairing flow, the retention of submission receipts, and the rule for two different nutrition targets saved for the same day on disconnected devices need decisions before managed rollout. The backup format and offline SQLite migrations have their own versions.
