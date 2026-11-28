import { addDays, calendarDate } from "./diary-view";

export function shiftDiaryMonth(day: string, offset: number): string | null {
  const date = calendarDate(`${day.slice(0, 7)}-01`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  const year = date.getUTCFullYear();
  return year >= 1 && year <= 9999 ? date.toISOString().slice(0, 10) : null;
}

export function diaryMonthWeeks(month: string): (string | null)[][] {
  const first = calendarDate(month);
  const firstColumn = (first.getUTCDay() + 6) % 7;
  const last = calendarDate(month);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  const days = last.getUTCDate();
  const weeks = Math.ceil((firstColumn + days) / 7);
  return Array.from({ length: weeks }, (_, week) =>
    Array.from({ length: 7 }, (_, weekday) => {
      const offset = week * 7 + weekday - firstColumn;
      return offset >= 0 && offset < days ? addDays(month, offset) : null;
    }),
  );
}
