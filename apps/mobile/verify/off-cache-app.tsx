import type { CachedPackagedFood } from "@edo/storage";
import { File, Paths } from "expo-file-system";
import { openDatabaseAsync } from "expo-sqlite";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { openLocalPackagedCache } from "../src/local-packaged-cache";
import { products } from "./off-cache-products";

const maxUnretainedBytes = 4 * 1024 * 1024;
const cacheName = "edo-packaged-foods.db";
const first = products[0];
const second = products[1];
const old = products[2];
const recent = products.at(-1);

function marker(name: string) {
  return new File(Paths.document, `edo-cache-${name}`);
}

function publish(name: string, contents: string) {
  const staged = marker(`${name}.partial`);
  staged.create({ overwrite: true });
  staged.writeSync(contents);
  staged.moveSync(marker(name), { overwrite: true });
}

function measure(fn: (index: number) => CachedPackagedFood[]) {
  const durations: number[] = [];
  let resultCount = 0;
  for (let index = 0; index < 31; index++) {
    const start = performance.now();
    const matches = fn(index);
    resultCount = matches.length;
    if (!resultCount) throw new Error("A sampled lookup returned no match");
    durations.push(performance.now() - start);
  }
  const firstMs = durations.shift();
  durations.sort((a, b) => a - b);
  return { firstMs, p50Ms: durations[14], p95Ms: durations[28], resultCount };
}

async function verify() {
  if (!first || !second || !old || !recent) throw new Error("Missing product fixture");
  const retained = [first.id.sourceId, second.id.sourceId];
  const seeded = marker("seeded").exists;
  const openStart = performance.now();
  const opened = await openLocalPackagedCache();
  const openMs = performance.now() - openStart;
  try {
    if (!seeded) {
      for (let index = 0; index < products.length; index += 512) {
        opened.cache.save(products.slice(index, index + 512), index + 1, retained);
      }
    }
    const now = Date.now();
    const searchWord = /[\p{L}\p{N}]{4,}/u.exec(recent.name)?.[0];
    if (!searchWord) throw new Error("The recent fixture has no searchable token");
    const barcode = measure((index) => opened.cache.lookupBarcode(recent.barcode, now + index));
    const name = measure((index) => opened.cache.search(searchWord, now + 100 + index));
    if (opened.cache.findByIds(retained, now + 200).length !== retained.length)
      throw new Error("An older retained product was evicted");
    if (opened.cache.lookupBarcode(old.barcode, now + 201).length !== 0)
      throw new Error("Expected an older ordinary product to be evicted");
    await opened.close();

    const db = await openDatabaseAsync(cacheName, { useNewConnection: true }, Paths.cache.uri);
    try {
      const counters = await db.getFirstAsync<{ storedCount: number; unretainedBytes: number }>(
        `SELECT count(*) AS storedCount,
          total(CASE WHEN source_id NOT IN (?, ?) THEN length(CAST(payload AS BLOB)) ELSE 0 END)
            AS unretainedBytes
          FROM packaged_food`,
        retained,
      );
      if (
        !counters ||
        counters.unretainedBytes > maxUnretainedBytes ||
        counters.unretainedBytes < 0.95 * maxUnretainedBytes ||
        counters.storedCount >= products.length
      ) {
        throw new Error(`Unexpected cache payload budget ${JSON.stringify(counters)}`);
      }
      const integrity = await db.getFirstAsync<{ quick_check: string }>("PRAGMA quick_check");
      if (integrity?.quick_check !== "ok") throw new Error("Native cache quick check failed");
      const fileBytes = new File(Paths.cache, cacheName).size;
      const walBytes = new File(Paths.cache, `${cacheName}-wal`).size ?? 0;
      const shmBytes = new File(Paths.cache, `${cacheName}-shm`).size ?? 0;
      publish(
        seeded ? "reopened" : "seeded",
        JSON.stringify({
          offeredCount: products.length,
          ...counters,
          retainedCount: retained.length,
          fileBytes,
          walBytes,
          shmBytes,
          openMs,
          barcode,
          name,
        }),
      );
    } finally {
      await db.closeAsync();
    }
  } catch (error) {
    await opened.close().catch(() => undefined);
    throw error;
  }
}

export default function App() {
  const [status, setStatus] = useState("Measuring the packaged-food cache");
  useEffect(() => {
    void verify().then(
      () => setStatus("Packaged-food cache verification passed"),
      (error: unknown) => {
        publish("failed", String(error));
        setStatus(String(error));
      },
    );
  }, []);
  return <Text>{status}</Text>;
}
