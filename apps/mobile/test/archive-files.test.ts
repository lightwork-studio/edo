import { beforeEach, expect, it, vi } from "vitest";
import {
  ArchiveComplexityError,
  ArchiveSizeError,
  pruneArchiveExports,
  shareArchive,
} from "../src/archive-files";

const mock = vi.hoisted(() => ({
  directories: new Set<string>(),
  files: new Map<string, string>(),
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
      return new TextEncoder().encode(mock.files.get(this.uri) ?? "").length;
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
  pruneArchiveExports(100 + 24 * 60 * 60 * 1000);
  expect(mock.files.get(uri)).toBeUndefined();
  expect(mock.files.get(`${unowned}/keep.json`)).toBe("keep");
});

it("cleans up the export if the native share operation fails", async () => {
  mock.share.mockRejectedValueOnce(new Error("Share failed"));
  await expect(shareArchive("synthetic source", 200)).rejects.toThrow(/share failed/i);
  expect(mock.files.size).toBe(0);
});

it("does not stage private data if the system share sheet is unavailable", async () => {
  mock.sharingAvailable.mockResolvedValueOnce(false);
  await expect(shareArchive("{}")).rejects.toThrow(/unavailable/i);
  expect(mock.share).not.toHaveBeenCalled();
  expect(mock.files.size).toBe(0);
});

it("checks UTF-8 bytes and removes oversized staging before the native share call", async () => {
  const source = JSON.stringify({ note: "ü".repeat(8 * 1024 * 1024) });
  await expect(shareArchive(source)).rejects.toBeInstanceOf(ArchiveSizeError);
  expect(mock.share).not.toHaveBeenCalled();
  expect(mock.files.size).toBe(0);
});

it("does not share an archive that exceeds the mobile restore complexity budget", async () => {
  const source = `{"format":"edo-diary","formatVersion":2,"meals":[${"{},".repeat(300_000)}{}]}`;
  await expect(shareArchive(source)).rejects.toBeInstanceOf(ArchiveComplexityError);
  expect(mock.files.size).toBe(0);
  expect(mock.share).not.toHaveBeenCalled();
});
