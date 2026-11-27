# Open Food Facts catalog refresh

Edo produces one German-market SQLite catalog and a manifest per release. The full import
establishes the baseline. Incremental imports use the Open Food Facts
[delta index](https://static.openfoodfacts.org/data/delta/index.txt), which lists retained
gzip files of changed product records. The baseline and all delta releases use the same
SQLite schema, nutrition mapping and attribution.

## Bootstrap or reconcile

Before the full export you intend to import is generated, record the current end timestamp
from the delta index. This timestamp is the bootstrap checkpoint. Then wait for a full export
generated after that checkpoint and run the full refresh.

```sh
pnpm --filter @edo/off-import run refresh "$CATALOG_ROOT"
pnpm --filter @edo/off-import run delta "$CATALOG_ROOT" "$BOOTSTRAP_UNIX_SECONDS"
```

Use a checkpoint that predates the start of the full export. The full export's HTTP
Last-Modified describes the published file, so it cannot establish that checkpoint by
itself. The first delta run requires the retained windows to cover the checkpoint and
catch up to the full export's Last-Modified. Rows from overlapping windows at or before
the checkpoint are skipped.

After bootstrapping, run this for both scheduled refreshes and retries:

```sh
pnpm --filter @edo/off-import run delta "$CATALOG_ROOT"
```

The importer verifies the active manifest and SQLite artifact, then applies contiguous
windows in chronological order to a private copy. Each changed record is re-evaluated for
the German catalog. Validation checks SQLite integrity, indexes, foreign keys and row counts
before activating the new manifest. An interrupted or rejected batch leaves the prior manifest
and checkpoint active.

The delta manifest records the end timestamp in `source.lastModified` and in its
`off-delta-v1` release identifier. Its source SHA-256 covers the receipt containing the parent
manifest checksum, the applied window, and each downloaded file's URL, checksum and size.
The accepted count describes the complete output catalog. Rejected and skipped counts
describe rows processed in the delta batch.

Reconcile periodically from a full export because hard deletions can disappear without a delta
record. A gap beyond the retained window also requires a fresh baseline. If a delta release
needs to be rolled back, use `pnpm --filter @edo/off-import run restore "$CATALOG_ROOT"
"$MANIFEST_SHA256"` with a previously activated release, then rerun the delta importer. If the
restored release is a full snapshot, reuse its recorded bootstrap checkpoint or establish a
fresh baseline.
