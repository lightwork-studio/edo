import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import { deserializeDatabaseAsync } from "expo-sqlite";
import { blsSeedAsset } from "./catalog-seed";

export async function openLocalCatalog() {
  const [asset] = await Asset.loadAsync(blsSeedAsset);
  if (!asset?.localUri) throw new Error("Missing bundled BLS catalog");

  // The bundled public catalog is small enough to open in memory, separate from the diary file.
  const bytes = await new File(asset.localUri).bytes();
  const db = await deserializeDatabaseAsync(bytes);
  try {
    await db.execAsync("PRAGMA query_only = ON");
    const metadata = await db.getFirstAsync<{ release: string }>(
      "SELECT release FROM catalog_metadata WHERE singleton = 1 AND provider = 'bls'",
    );
    if (metadata?.release !== "4.0-2025") throw new Error("Unexpected BLS catalog release");
    return { db, close: () => db.closeAsync() };
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}
