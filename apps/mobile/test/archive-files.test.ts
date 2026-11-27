import { createDiaryItem, type Food } from "@edo/core";
import { beforeEach, expect, it, vi } from "vitest";
import { pruneArchiveExports, shareArchive } from "../src/archive-files";

const mock = vi.hoisted(() => ({
  directories: new Set<string>(),
  files: new Map<string, string>(),
  measuredSize: undefined as number | undefined,
  undeletable: undefined as string | undefined,
  share: vi.fn(),
  sharingAvailable: vi.fn(),
}));

vi.mock("expo-crypto", () => ({
  randomUUID: () => "a1234567-1234-4321-abcd-123456789abc",
}));

vi.mock("expo-sharing", () => ({
  isAvailableAsync: mock.sharingAvailable,
  shareAsync: mock.share,
}));

vi.mock("expo-file-system", () => {
  function uri(parts: (string | { uri: string })[]) {
    return parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
  }

  class Directory {
    readonly uri: string;
    constructor(...parts: (string | Directory)[]) {
      this.uri = uri(parts);
    }
    get name() {
      return this.uri.split("/").at(-1);
    }
    get exists() {
      return mock.directories.has(this.uri);
    }
    create() {
      mock.directories.add(this.uri);
      mock.directories.add(this.uri.slice(0, this.uri.lastIndexOf("/")));
    }
    delete() {
      if (this.uri === mock.undeletable) throw new Error("Cache delete failed");
      mock.directories.delete(this.uri);
      for (const path of mock.files.keys()) {
        if (path.startsWith(`${this.uri}/`)) mock.files.delete(path);
      }
    }
    list() {
      const prefix = `${this.uri}/`;
      return [...mock.directories]
        .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
        .map((path) => new Directory(path));
    }
  }

  class File {
    readonly uri: string;
    constructor(...parts: (string | Directory)[]) {
      this.uri = uri(parts);
    }
    get size() {
      return mock.measuredSize ?? Buffer.byteLength(mock.files.get(this.uri) ?? "");
    }
    create() {
      mock.files.set(this.uri, "");
    }
    async write(text: string) {
      mock.files.set(this.uri, text);
    }
  }

  return { Directory, File, Paths: { cache: new Directory("file:///cache") } };
});

beforeEach(() => {
  mock.directories.clear();
  mock.files.clear();
  mock.measuredSize = undefined;
  mock.undeletable = undefined;
  mock.share.mockReset();
  mock.sharingAvailable.mockReset().mockResolvedValue(true);
});

it("writes an export in its private cache, shares it, and later removes expired staging only", async () => {
  const source = '{"format":"edo-diary","formatVersion":2}';
  const root = "file:///cache/edo-diary-exports";
  const unowned = `${root}/separate-folder`;
  mock.directories.add(unowned);
  mock.files.set(`${unowned}/keep.json`, "keep");
  await shareArchive(source, 100);
  const [uri, options] = mock.share.mock.calls[0] ?? [];
  expect(uri).toBe(`${root}/100-a1234567-1234-4321-abcd-123456789abc/edo-diary.json`);
  expect(options).toEqual({ mimeType: "application/json", UTI: "public.json" });
  expect(mock.files.get(uri)).toBe(source);
  pruneArchiveExports(100 + 24 * 60 * 60 * 1000 - 1);
  expect(mock.files.get(uri)).toBe(source);
  pruneArchiveExports(100 + 24 * 60 * 60 * 1000);
  expect(mock.files.get(uri)).toBeUndefined();
  expect(mock.files.get(`${unowned}/keep.json`)).toBe("keep");
});

it("cleans up the export if the native share operation fails", async () => {
  mock.share.mockRejectedValueOnce(new Error("Share failed"));
  await expect(shareArchive("synthetic source", 200)).rejects.toThrow(/share failed/i);
  expect(mock.files.size).toBe(0);
});

it("keeps pruning expired exports when deleting one staging directory fails", async () => {
  await shareArchive("{}", 100);
  await shareArchive("{}", 200);
  mock.undeletable = "file:///cache/edo-diary-exports/100-a1234567-1234-4321-abcd-123456789abc";
  pruneArchiveExports(200 + 24 * 60 * 60 * 1000);
  expect([...mock.files.keys()]).toEqual([`${mock.undeletable}/edo-diary.json`]);
  mock.undeletable = undefined;
  pruneArchiveExports(200 + 24 * 60 * 60 * 1000);
  expect(mock.files.size).toBe(0);
});

it("does not stage private data if the system share sheet is unavailable", async () => {
  mock.sharingAvailable.mockResolvedValueOnce(false);
  await expect(shareArchive("{}")).rejects.toThrow(/unavailable/i);
  expect(mock.share).not.toHaveBeenCalled();
  expect(mock.files.size).toBe(0);
});

it("removes a staged file when its size cannot be verified", async () => {
  mock.measuredSize = 0;
  await expect(shareArchive("{}")).rejects.toThrow(/verify the staged archive/);
  expect(mock.share).not.toHaveBeenCalled();
  expect(mock.files.size).toBe(0);
});

it("shares a multi-year diary that exceeds 16 MiB without truncation", async () => {
  const food: Food = {
    id: { provider: "local", sourceId: "synthetic-juice" },
    name: "Apfelsaft, ungesüßt",
    release: null,
    preparation: "unknown",
    nutrition: {
      basis: "per-100-ml",
      nutrients: { kcal: 46, proteinG: 0, availableCarbohydratesG: 11, fatG: 0, fiberG: null },
    },
  };
  const meals = Array.from({ length: 4 * 365 * 3 }, (_, index) => {
    const occurredAt = Date.UTC(2022, 0, 1 + Math.floor(index / 3), 8 + 5 * (index % 3));
    return {
      id: `meal-${index}`,
      localDay: new Date(occurredAt).toISOString().slice(0, 10),
      occurredAt,
      items: Array.from({ length: 5 }, (_, slot) =>
        createDiaryItem(`item-${index}-${slot}`, food, { amount: 150, unit: "ml" }),
      ),
    };
  });
  const source = JSON.stringify({ format: "edo-diary", formatVersion: 1, meals }, null, 2);
  expect(Buffer.byteLength(source)).toBeGreaterThan(16 * 1024 * 1024);
  await shareArchive(source);
  expect(mock.files.get(mock.share.mock.calls[0]?.[0])).toBe(source);
});

it("keeps pending handoffs alive during cleanup and prevents overlapping shares", async () => {
  let finish: (() => void) | undefined;
  mock.share.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const first = shareArchive("{}", 100);
  await vi.waitFor(() => expect(mock.share).toHaveBeenCalledOnce());
  const expiry = 100 + 24 * 60 * 60 * 1000;
  await expect(shareArchive("{}", expiry)).rejects.toThrow(/in progress/);
  pruneArchiveExports(expiry);
  expect(mock.files.size).toBe(1);
  finish?.();
  await first;
  pruneArchiveExports(expiry);
  expect(mock.files.size).toBe(0);
  await shareArchive("{}", expiry);
  expect(mock.share).toHaveBeenCalledTimes(2);
});
