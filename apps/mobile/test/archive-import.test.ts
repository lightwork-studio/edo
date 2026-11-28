import { beforeEach, expect, it, vi } from "vitest";
import {
  ArchiveComplexityError,
  ArchiveProviderBusyError,
  ArchiveReadTimeoutError,
  ArchiveSizeError,
  archivePickerAvailable,
  chooseArchive,
  chooseFddbCsv,
  fddbPickerAvailable,
} from "../src/archive-import";

const mock = vi.hoisted(() => ({
  available: true,
  csvAvailable: true,
  pickArchiveAsync: vi.fn(),
  pickFddbCsvAsync: vi.fn(),
}));

vi.mock("expo", () => ({
  requireOptionalNativeModule: (name: string) =>
    mock.available && name === "EdoArchivePicker"
      ? {
          pickArchiveAsync: mock.pickArchiveAsync,
          pickFddbCsvAsync: mock.csvAvailable ? mock.pickFddbCsvAsync : undefined,
        }
      : null,
}));

beforeEach(() => {
  mock.available = true;
  mock.csvAvailable = true;
  mock.pickArchiveAsync.mockReset();
  mock.pickFddbCsvAsync.mockReset();
});

it("accepts UTF-8 archive text from the picker and handles cancellation", async () => {
  const source = JSON.stringify({ format: "edo-diary", name: "Übung 🍎" });
  mock.pickArchiveAsync
    .mockResolvedValueOnce({ status: "selected", source: `\uFEFF${source}` })
    .mockResolvedValueOnce({ status: "cancelled" });
  expect(archivePickerAvailable).toBe(true);
  await expect(chooseArchive()).resolves.toBe(source);
  await expect(chooseArchive()).resolves.toBeNull();
});

it("reads CSV through the same bounded picker without treating its text as JSON structure", async () => {
  const csv = `date;food\n27.11.2026;${"[".repeat(100)}`;
  mock.pickFddbCsvAsync.mockResolvedValueOnce({ status: "selected", source: `\uFEFF${csv}` });
  expect(fddbPickerAvailable).toBe(true);
  await expect(chooseFddbCsv()).resolves.toBe(csv);
  expect(mock.pickFddbCsvAsync).toHaveBeenCalledTimes(1);
  expect(mock.pickArchiveAsync).not.toHaveBeenCalled();
});

it("reports the native size rejection and permits another choice", async () => {
  mock.pickArchiveAsync
    .mockResolvedValueOnce({ status: "too-large" })
    .mockResolvedValueOnce({ status: "selected", source: "{}" });
  await expect(chooseArchive()).rejects.toBeInstanceOf(ArchiveSizeError);
  await expect(chooseArchive()).resolves.toBe("{}");
});

it("reports a provider deadline and permits a new selection", async () => {
  mock.pickArchiveAsync
    .mockRejectedValueOnce({ code: "ERR_EDO_ARCHIVE_TIMEOUT" })
    .mockResolvedValueOnce({ status: "selected", source: "{}" });
  await expect(chooseArchive()).rejects.toBeInstanceOf(ArchiveReadTimeoutError);
  await expect(chooseArchive()).resolves.toBe("{}");
});

it("distinguishes provider saturation from a malformed archive", async () => {
  mock.pickArchiveAsync.mockRejectedValueOnce({ code: "ERR_EDO_ARCHIVE_PROVIDER_BUSY" });
  await expect(chooseArchive()).rejects.toBeInstanceOf(ArchiveProviderBusyError);
});

it("rejects a 15 MB selection with millions of objects before the store parses it", async () => {
  const source = `{"format":"edo-diary","formatVersion":1,"meals":[${"{},".repeat(4_999_999)}{}]}`;
  mock.pickArchiveAsync.mockResolvedValueOnce({ status: "selected", source });
  await expect(chooseArchive()).rejects.toBeInstanceOf(ArchiveComplexityError);
});

it("rejects deep JSON nesting and permits structural symbols inside quoted strings", async () => {
  const source = JSON.stringify({ note: 'a\\"[{,'.repeat(175_000) });
  mock.pickArchiveAsync
    .mockResolvedValueOnce({ status: "selected", source: `${"[".repeat(256)}0${"]".repeat(256)}` })
    .mockResolvedValueOnce({ status: "selected", source });
  await expect(chooseArchive()).rejects.toBeInstanceOf(ArchiveComplexityError);
  await expect(chooseArchive()).resolves.toBe(source);
});

it("prevents overlapping selections across screens and unlocks after a provider failure", async () => {
  let rejectPick: ((reason: Error) => void) | undefined;
  mock.pickArchiveAsync.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectPick = reject;
      }),
  );
  const first = chooseArchive();
  await expect(chooseFddbCsv()).rejects.toThrow(/selection is unavailable/);
  rejectPick?.(new Error("Provider failed"));
  await expect(first).rejects.toThrow(/Provider failed/);
  mock.pickArchiveAsync.mockResolvedValueOnce({ status: "cancelled" });
  await expect(chooseArchive()).resolves.toBeNull();
  expect(mock.pickArchiveAsync).toHaveBeenCalledTimes(2);
});

it("keeps archive restore available on a native build without the CSV picker", async () => {
  mock.csvAvailable = false;
  vi.resetModules();
  const archiveOnly = await import("../src/archive-import");
  mock.pickArchiveAsync.mockResolvedValueOnce({ status: "selected", source: "{}" });
  expect(archiveOnly.fddbPickerAvailable).toBe(false);
  await expect(archiveOnly.chooseFddbCsv()).rejects.toThrow(/selection is unavailable/);
  await expect(archiveOnly.chooseArchive()).resolves.toBe("{}");
});

it("disables restore when the native picker is unavailable", async () => {
  mock.available = false;
  vi.resetModules();
  const unsupported = await import("../src/archive-import");
  expect(unsupported.archivePickerAvailable).toBe(false);
  await expect(unsupported.chooseArchive()).rejects.toThrow(/selection is unavailable/);
  expect(mock.pickArchiveAsync).not.toHaveBeenCalled();
});
