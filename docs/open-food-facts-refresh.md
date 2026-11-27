# Open Food Facts catalog refresh

Edo produces one German-market SQLite catalog and a manifest per release. The full import
establishes the baseline. Incremental imports use the Open Food Facts
[delta index](https://static.openfoodfacts.org/data/delta/index.txt), which lists retained
gzip files of changed product records. The baseline and all delta releases use the same
SQLite schema, nutrition mapping and attribution.

## Bootstrap or reconcile

In a separate catalog root, record the latest end timestamp from the delta index and the
current full export's ETag before the next full export is generated. The delta timestamp is
the bootstrap checkpoint. Wait for a new full export with a changed ETag as well as a later
Last-Modified, so republishing the previous file does not count as a new baseline.

```sh
pnpm --filter @edo/off-import run refresh "$CATALOG_ROOT"
pnpm --filter @edo/off-import run delta "$CATALOG_ROOT" "$BOOTSTRAP_UNIX_SECONDS"
```

Use a checkpoint that predates the start of the full export. The full export's HTTP
Last-Modified describes the published file, so it cannot establish that checkpoint by
itself. Choose the delta window adjacent to the full export. Its start must match the
checkpoint and its end must be at or after the full export's Last-Modified. Starting with an
earlier closed window could replay a product that had already been removed by the time of the
full export.

After bootstrapping, run this for both scheduled refreshes and retries:

```sh
pnpm --filter @edo/off-import run delta "$CATALOG_ROOT"
```

The importer verifies the active manifest and SQLite artifact, then applies contiguous
windows in chronological order to a private copy. Each changed record is re-evaluated for
the German catalog. Validation checks SQLite integrity, indexes, foreign keys and row counts
before activating the new manifest. An interrupted or rejected batch leaves the prior manifest
and checkpoint active. A retry clears the previous job's private `.delta-work` scratch.

The delta manifest records the end timestamp in `source.lastModified` and in its
`off-delta-v1` release identifier. Its source SHA-256 covers the receipt containing the parent
manifest checksum, the applied window, and each downloaded file's URL, checksum and size.
Receipts are retained at `open-food-facts/delta-sources/<source-sha256>.json`.
The accepted count describes the complete output catalog. Rejected and skipped counts
describe rows processed in the delta batch.

Reconcile periodically from a full export because hard deletions can disappear without a delta
record. A gap beyond the retained window also requires a fresh baseline. If a delta release
needs to be rolled back, use `pnpm --filter @edo/off-import run restore "$CATALOG_ROOT"
"$MANIFEST_SHA256"` with a previously activated release, then rerun the delta importer. If the
restored release is a full snapshot, reuse its recorded bootstrap checkpoint or establish a
fresh baseline. Restore a full release before reverting server code to a version that predates
delta support. A reconciled scratch root contains only its new Open Food Facts releases. Publish
that provider's verified release into the existing catalog store, preserving BLS and the known
Open Food Facts history.

## GitHub Actions and Cloudflare

Create the private R2 bucket `edo-catalogs`. In GitHub, configure the `catalog-production`
environment with a deployment branch policy that permits only `main`. Production publication
also requires `main` to be protected with pull requests and the repository's existing check.
Set environment variable
`EDO_R2_ACCOUNT_ID` and environment secrets `EDO_R2_ACCESS_KEY_ID` and
`EDO_R2_SECRET_ACCESS_KEY` using an R2 token limited to object read/write for this bucket.

Seed Open Food Facts from a locally verified delta release with the AWS CLI installed and R2
credentials in the shell environment:

```sh
node apps/catalog-edge/publish.ts publish open-food-facts "$CATALOG_ROOT" empty
```

A reviewed BLS release uses provider `bls` and an additional argument containing the exact
artifact SHA-256 recorded during review. Use `empty` only for the first publication of a
provider. To roll back, disable `EDO_CATALOG_REFRESH_ENABLED` and wait
for any publication already running. Prepare the desired catalog locally and pass the active
manifest's SHA-256 in place of `empty`. Obtain the SHA-256 from the provider's R2 `state.json`
if the active manifest is unreadable. Keep refresh paused until the cause is fixed or a fresh
baseline is seeded so the job does not replay the same bad deltas.

After seeding and configuring credentials, set repository variable
`EDO_CATALOG_REFRESH_ENABLED=true` to enable the job.
Run **Refresh Open Food Facts catalog** manually once on `main` to verify the schedule's path.
Subsequent runs are scheduled for 04:17 UTC. The job restores the prior manifest and artifact
from R2, then applies retained deltas. It verifies newly written immutable objects before
updating publication state using a conditional write. The Worker exposes only catalog objects
listed in that state, including earlier published releases. A source checkpoint over 72 hours old
fails the job, so GitHub Actions failure notifications can surface stalled publication when the
job runs. If nightly runs stop appearing, check whether GitHub disabled the schedule after
repository inactivity. Re-enable the workflow and dispatch it on the current `main`.

The Worker serves the current manifests, immutable artifacts, and barcode lookups under
`/catalog-preview/` at `edo.timweb.app`. Deploy the staging Worker with
`wrangler deploy --config apps/catalog-edge/wrangler.jsonc --env staging` and verify its active
manifest, SQLite digest, and a known barcode. After those checks, deploy the production
configuration without `--env staging` to attach the custom domain. Keep previous releases in R2
so they can be republished if an update fails.
