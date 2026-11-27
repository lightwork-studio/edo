import { beforeEach, expect, it, vi } from "vitest";
import { chooseArchive, pruneArchiveExports, shareArchive } from "../src/archive-files";

const mock = vi.hoisted(() => ({
  directories: new Set<string>(),
  files: new Map<string, string>(),
  choose: vi.fn(),
  share: vi.fn(),
  sharingAvailable: vi.fn(),
}));

vi.mock("expo-crypto", () => ({
  randomUUID: () => "a1234567-1234-4321-abcd-123456789abc",
}));

vi.mock("expo-document-picker", () => ({ getDocumentAsync: mock.choose }));
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
    get parentDirectory() {
      return new Directory(this.uri.slice(0, this.uri.lastIndexOf("/")));
    }
    get exists() {
      return mock.files.has(this.uri);
    }
    create() {
      mock.files.set(this.uri, "");
    }
    async write(text: string) {
      mock.files.set(this.uri, text);
    }
    async text() {
      const source = mock.files.get(this.uri);
      if (source === undefined) throw new Error("Missing selected file");
      return source;
    }
    delete() {
      mock.files.delete(this.uri);
    }
  }

  return { Directory, File, Paths: { cache: new Directory("file:///cache") } };
});

beforeEach(() => {
  mock.directories.clear();
  mock.files.clear();
  mock.choose.mockReset();
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

it("reads and removes the picker copy, and keeps a file the picker returns outside its cache", async () => {
  const copy = "file:///cache/DocumentPicker/copy.json";
  const selected = "file:///documents/original.json";
  mock.files.set(copy, "picked copy");
  mock.files.set(selected, "original");
  mock.choose
    .mockResolvedValueOnce({ canceled: false, assets: [{ uri: copy }] })
    .mockResolvedValueOnce({ canceled: false, assets: [{ uri: selected }] })
    .mockResolvedValueOnce({ canceled: true, assets: null });
  await expect(chooseArchive()).resolves.toBe("picked copy");
  expect(mock.files.has(copy)).toBe(false);
  await expect(chooseArchive()).resolves.toBe("original");
  expect(mock.files.get(selected)).toBe("original");
  await expect(chooseArchive()).resolves.toBeNull();
  expect(mock.choose).toHaveBeenCalledWith(
    expect.objectContaining({ copyToCacheDirectory: true, multiple: false }),
  );
});
