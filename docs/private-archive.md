# Private diary archive

The device diary exposes a UTF-8 JSON archive through `exportPrivateArchive` on the
store returned by `openDiary`. The archive uses `format: "edo-diary"` and
`formatVersion: 2`. It carries the private records needed to move an offline diary.

- `meals` records each saved local calendar day, UTC instant in milliseconds, and captured
  `utcOffsetMinutes` when known. Its ordered item snapshots include the food identity and
  source release, the portion, the food's nutrition basis, and the nutrient values captured
  when logging. A JSON null nutrient represents an unknown value.
- `customFoods`, `recipes` and `mealTemplates` preserve the local library. Recipe ingredients
  and template items carry their captured food, amount and nutrition. Favorites are provider
  and source ID pairs. A packaged favorite may need to be resolved again on a new device.
- `weighIns` contains measured kilograms by recorded local day and UTC instant.
  `nutritionTargets` carries each revision and its effective day. The oldest saved revision
  appears first for each day so the same target remains effective after restore.

The restore methods also accept format version 1 meal-only archives. Additional private
collections keep their saved records. Public catalog assets and cache contents live separately.

## Restore behavior

Call `previewPrivateArchive` to inspect new, already-present and conflicting records.
Call `restorePrivateArchive` with the same text to recheck under a write transaction and insert
missing records. A matching ID and identical content is safe to retry. Conflicting IDs, invalid
records, and ambiguous same-day target order reject the whole restore. A runtime write failure
rolls back the transaction. Fix the source of the conflict before retrying.

The archive contains private diary data in clear text. Keep the file in a location appropriate
for personal records.

On iOS or Android, open **Progress**, then **Diary files**. Share a new archive through the
system share sheet. An Edo development or release build can open a previously exported file
in place to preview its restore. The picker reads up to 16 MiB plus one byte to detect an
oversized file, and the app checks JSON depth and structure before parsing. The phone applies
the preview only after you select **Restore records**.

Sharing uses a temporary copy in the application cache. The app clears expired staging copies
on startup, on resume or when another archive is shared. The staging window is one day to
give the receiving app time to read the file.
