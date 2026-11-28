import type { WeighIn } from "@edo/core";
import type { WeighInProjector } from "@edo/sync";
import { readSavedWeighIn, readWeighIn, writeWeighIn } from "./diary-progress.ts";
import { diaryId } from "./snapshot.ts";
import type { DiarySqliteConnection } from "./sqlite.ts";

/** Called synchronously during the journal's page or receipt transaction. */
export function projectSyncedWeighIn(db: DiarySqliteConnection): WeighInProjector {
  return (change, expected) => {
    const id = diaryId(change.id, "weigh-in ID");
    if (JSON.stringify(readSavedWeighIn(db, id)) !== JSON.stringify(expected)) {
      throw new Error("The saved weigh-in needs review before applying the account update");
    }
    let projected: WeighIn | null = null;
    if (change.state === "live") {
      const { id: contentId, localDay, occurredAt, kg } = change.content;
      if (contentId !== id)
        throw new Error("The account weigh-in identity differs from the envelope");
      projected = readWeighIn({ id, local_day: localDay, occurred_at: occurredAt, kg });
      writeWeighIn(db, projected);
    } else if (change.state === "deleted") {
      db.run("DELETE FROM main.diary_weigh_ins WHERE id = ?", id);
    } else {
      throw new Error("This account weigh-in is unavailable");
    }
    const persisted = readSavedWeighIn(db, id);
    if (JSON.stringify(persisted) !== JSON.stringify(projected)) {
      throw new Error("The applied weigh-in changed while saving");
    }
    return persisted ? { ...persisted } : null;
  };
}
