import { openOffContributionQueue } from "@edo/storage";
import { openDatabaseAsync } from "expo-sqlite";
import { connectionFor } from "./local-sqlite";

export async function openLocalOffContributionQueue() {
  const db = await openDatabaseAsync("edo-off-contributions.db", { useNewConnection: true });
  try {
    return { queue: openOffContributionQueue(connectionFor(db)), close: () => db.closeAsync() };
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}
