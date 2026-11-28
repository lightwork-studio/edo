import { expect, test } from "vitest";
import { diaryMonthWeeks, diaryWeekDates, shiftDiaryMonth } from "../src/diary-calendar";

test("lays out a leap February in complete Monday-first rows", () => {
  const weeks = diaryMonthWeeks("2028-02-01");
  expect(weeks[0]).toEqual([
    null,
    "2028-02-01",
    "2028-02-02",
    "2028-02-03",
    "2028-02-04",
    "2028-02-05",
    "2028-02-06",
  ]);
  expect(weeks.at(-1)).toEqual(["2028-02-28", "2028-02-29", null, null, null, null, null]);
});

test("moves months across year boundaries without rolling a late date into another month", () => {
  expect(shiftDiaryMonth("2026-12-31", 1)).toBe("2027-01-01");
  expect(shiftDiaryMonth("2026-03-31", -1)).toBe("2026-02-01");
  expect(shiftDiaryMonth("0001-01-01", -1)).toBe("0000-12-01");
  expect(shiftDiaryMonth("0000-01-01", -1)).toBeNull();
  expect(shiftDiaryMonth("9999-12-31", 1)).toBeNull();
  expect(diaryMonthWeeks("9999-12-01").at(-1)).toEqual([
    "9999-12-27",
    "9999-12-28",
    "9999-12-29",
    "9999-12-30",
    "9999-12-31",
    null,
    null,
  ]);
});

test("only places supported days in the first and last diary weeks", () => {
  expect(diaryWeekDates("0000-01-01")).toEqual([
    null,
    null,
    null,
    null,
    null,
    "0000-01-01",
    "0000-01-02",
  ]);
  expect(diaryWeekDates("9999-12-31")).toEqual([
    "9999-12-27",
    "9999-12-28",
    "9999-12-29",
    "9999-12-30",
    "9999-12-31",
    null,
    null,
  ]);
});
