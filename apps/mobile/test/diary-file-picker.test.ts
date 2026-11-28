import { beforeEach, expect, it, vi } from "vitest";
import {
  chooseFddbCsv,
  DiaryFileProviderBusyError,
  DiaryFileReadTimeoutError,
  DiaryFileSizeError,
  fddbPickerAvailable,
} from "../src/diary-file-picker";

const mock = vi.hoisted(() => ({
  supportsCsv: true,
  pickFddbCsvAsync: vi.fn(),
}));

vi.mock("expo", () => ({
  requireOptionalNativeModule: (name: string) =>
    name === "EdoArchivePicker" && mock.supportsCsv
      ? { pickFddbCsvAsync: mock.pickFddbCsvAsync }
      : null,
}));

beforeEach(() => {
  mock.supportsCsv = true;
  mock.pickFddbCsvAsync.mockReset();
});

it("returns the selected UTF-8 CSV without the optional BOM and respects cancellation", async () => {
  const source = "Datum;Lebensmittel\r\n27.11.2026;Äpfel";
  mock.pickFddbCsvAsync
    .mockResolvedValueOnce({ status: "selected", source: `\uFEFF${source}` })
    .mockResolvedValueOnce({ status: "cancelled" });
  expect(fddbPickerAvailable).toBe(true);
  await expect(chooseFddbCsv()).resolves.toBe(source);
  await expect(chooseFddbCsv()).resolves.toBeNull();
});

it("reports native file limits and provider failures without blocking retries", async () => {
  mock.pickFddbCsvAsync
    .mockResolvedValueOnce({ status: "too-large" })
    .mockRejectedValueOnce({ code: "ERR_EDO_ARCHIVE_TIMEOUT" })
    .mockRejectedValueOnce({ code: "ERR_EDO_ARCHIVE_PROVIDER_BUSY" })
    .mockResolvedValueOnce({ status: "cancelled" });
  await expect(chooseFddbCsv()).rejects.toBeInstanceOf(DiaryFileSizeError);
  await expect(chooseFddbCsv()).rejects.toBeInstanceOf(DiaryFileReadTimeoutError);
  await expect(chooseFddbCsv()).rejects.toBeInstanceOf(DiaryFileProviderBusyError);
  await expect(chooseFddbCsv()).resolves.toBeNull();
});

it("prevents a second selection while the native picker is open", async () => {
  mock.pickFddbCsvAsync.mockResolvedValueOnce({ status: "cancelled" });
  const first = chooseFddbCsv();
  await expect(chooseFddbCsv()).rejects.toThrow("Diary file selection is unavailable");
  await expect(first).resolves.toBeNull();
  expect(mock.pickFddbCsvAsync).toHaveBeenCalledTimes(1);
});

it("reports picker availability on builds without the native file method", async () => {
  mock.supportsCsv = false;
  vi.resetModules();
  const unsupported = await import("../src/diary-file-picker");
  expect(unsupported.fddbPickerAvailable).toBe(false);
  await expect(unsupported.chooseFddbCsv()).rejects.toThrow("Diary file selection is unavailable");
  expect(mock.pickFddbCsvAsync).not.toHaveBeenCalled();
});
