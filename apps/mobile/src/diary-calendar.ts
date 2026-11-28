import { addDays, calendarDate } from "./diary-view";

/** Android's formatter uses the Julian calendar for earlier dates. */
export const firstGregorianDisplayDay = "1582-10-15";

function diaryKey(date: Date): string | null {
  const year = date.getUTCFullYear();
  return year >= 0 && year <= 9999 ? date.toISOString().slice(0, 10) : null;
}

export function shiftDiaryMonth(day: string, offset: number): string | null {
  const date = calendarDate(`${day.slice(0, 7)}-01`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return diaryKey(date);
}

export function diaryWeekDates(day: string): (string | null)[] {
  const first = calendarDate(day);
  first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(first);
    date.setUTCDate(first.getUTCDate() + index);
    return diaryKey(date);
  });
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
