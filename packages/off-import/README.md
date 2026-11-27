# Open Food Facts catalog

## Nightly refresh

Run this command once per night from the workspace root. Use the same command to rerun the job
manually.

```sh
pnpm --silent --filter @edo/off-import run refresh /absolute/path/catalogs
```

The command checks the official bulk export with a HEAD request. A matching upstream release and
verified active catalog result in a single metadata check. If a matching release gains a source
timestamp, the worker publishes a new manifest for the same SQLite file without downloading the
export. A future-dated upstream timestamp fails the refresh before download. For a new release, the
worker streams the gzip into a private publisher staging file and confirms its length and upstream
identity before the importer reads that same file. An upstream timestamp older than the source timestamp in the
verified active manifest stops the job before the download. A complete snapshot can
activate if the export rotates after the final metadata check, while SQLite is being built.

The importer verifies the gzip, catalog schema, SQLite integrity and row counts before atomically
replacing `open-food-facts/active.json`. An automatic refresh also stops if it accepts fewer than
half as many products as the previous verified, schema-compatible release. Investigate a large
drop before using a reviewed manual release. A failed check, download, or import exits nonzero and
leaves the active release in place. Previous immutable manifests and artifacts remain available.
The worker aborts a download after 60 seconds without response headers or body data.

Each successful run writes a JSON record with `status` (`published` or `unchanged`), `checkedAt`,
the active pointer's modification time as `activatedAt`, and the release manifest. The manifest
contains the upstream identity (strong ETag plus compressed size, with Last-Modified plus size as
the fallback and a weak ETag where provided). The identity includes a SHA-256 digest of the final
resource URL while the manifest links to the official export URL. The manifest also records the
source Last-Modified timestamp when available, source and artifact SHA-256 digests, and accepted,
rejected and skipped row counts.

Check the active release from the runner or its monitor using a maximum source age in hours.
Set the age to match the expected publication schedule.

```sh
pnpm --silent --filter @edo/off-import run health /absolute/path/catalogs 36
```

The check is read-only and makes no upstream requests. It checks the immutable manifest and SQLite
digest, then measures age from the source timestamp. A recent activation of an old snapshot still
reports `stale`. It prints JSON and exits 0 for `healthy`, 1 for a stale, unverified, undated or
future-dated source, or 2 for a usage or I/O error. A scheduler can route nonzero exits to its alerts
independently of the refresh job.

Use the repository's Node and pnpm versions and a persistent local filesystem with SQLite locking,
hard links and atomic renames. Allow outbound HTTPS to the export host and its redirect target.
Budget space for one compressed export during a scheduled refresh, the database and its SQLite
journal, and any retained releases. Use the HEAD response size to plan transfer and disk capacity.
A manual import of an existing archive also creates an isolated snapshot, which may require space
for another full copy. The refresh and manual importer share a worker lock for the same catalog
directory. A retry reclaims an interrupted download even if the upstream release is unchanged.
After a hard stop, stale `.stage-*` directories under `open-food-facts/` can be removed with all
catalog writers stopped.

## Worker sizing

The 26 November 2026 official export was 13.8 GB compressed. The first full measured import
completed in about 2 hours and 38 minutes on the development host, including the source staging,
hashing and SQLite verification. It produced a 95.3 MB German-market SQLite catalog with 427,921
products. The host's sampled peak process memory was about 194 MiB during parsing.

Budget for a full fetch and build when upstream publishes new bytes. The scheduled worker stages one
compressed copy, about 13.8 GB for the measured source. The manual benchmark needed another 13.8 GB
for its isolated snapshot. Allow additional space for retained raw snapshots, artifacts, and logs.
The 26 and 27 November exports had source timestamps around 05:40 UTC. Use 06:30 UTC as an initial
schedule and adjust it as the production worker collects more observations. Track the source
timestamp separately from the check and activation times to detect a stale upstream export.
[Open Food Facts export documentation](https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/).

## Recover a damaged release

1. Pause scheduled and manual catalog writers. Suspend catalog downloads if there is no verified
   release to serve during recovery.
2. Select a known-good `open-food-facts/releases/<manifest-sha>.json`. Verify that its SHA-256
   matches its filename and that it names the Open Food Facts provider and a supported schema.
   Verify the SHA-256 and byte size of `open-food-facts/artifacts/<artifact-sha>.sqlite` against
   that manifest. Open the artifact read-only and confirm `PRAGMA integrity_check` returns `ok`.
   If no release passes these checks, keep downloads paused and proceed to quarantine and rebuild.
3. Restore the verified release with the publisher command. It checks both files and preserves
   evidence of the displaced activation before changing `active.json`. If a directory occupies
   `active.json`, move it to private quarantine first. Use the catalog root and the known-good
   manifest's digest.

   ```sh
   pnpm --filter @edo/catalog-import run restore /absolute/path/catalogs open-food-facts <manifest-sha256>
   ```

4. Compare the reported digest-named file's SHA-256 to its filename, then move corrupt files to
   private quarantine outside the published catalog tree. Keep the known-good files in place.
   Rerun the refresh to rebuild the current export, or manually import a retained, verified archive
   for a historical release. Verify the resulting active manifest and artifact before resuming
   scheduled writers and any paused downloads.

## Manual release or backfill

Import a complete compressed [Open Food Facts export](https://world.openfoodfacts.org/data). Use
the upstream publication timestamp or another stable provider identifier for the release.

```sh
pnpm --filter @edo/off-import run import /absolute/path/export.jsonl.gz 2026-11-26 /absolute/path/catalogs
```

The importer streams the gzip, keeps products tagged for Germany, and validates a standalone SQLite
catalog before switching the Open Food Facts activation manifest. It preserves opaque product IDs,
barcode candidates, German and English names, nutrition basis, preparation and missing values.
Unqualified values, including zero, are imported as reported. Qualified values such as limits,
traces and estimates are stored as unknown. Reported kilojoules are converted to kilocalories
when kilocalories are unavailable. When the nutrition basis supplies a known mass, Edo records an
individual energy value over 10 kcal per gram or an individual gram nutrient exceeding the declared
mass by more than the greater of 1 g or 5% as unknown. This is a conservative filter for gross
source or measurement errors. Volume-based records require a supplied density to apply it.
[EU nutrition energy factors, Annex XIV](https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX%3A32011R1169).
Store-specific product codes use the provider's digit range.
When OFF cannot aggregate a single labeled serving, Edo can keep its per-serving values even
if the serving's measured size is unavailable. Multiple viable serving sets are left unresolved.
The database includes original barcodes, lookup indexes and a full-text search index.

BLS releases are imported separately from their pinned, reviewed publisher archives.

The data is from [Open Food Facts contributors](https://world.openfoodfacts.org/) under the
[Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/). For public use of the
derived catalog or a produced work based on it, provide the associated attribution and offer
the machine-readable SQLite snapshot as a free download with its manifest and ODbL notice.
See ODbL sections 4.2–4.6. The manifest records the source digest, transformation, output digest
and notice. Retain the exact source dump to reproduce a historical release. The upstream URL
serves the current export and may no longer serve those bytes.
