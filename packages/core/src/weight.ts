export interface WeighIn {
  readonly id: string;
  /** The local calendar day recorded on the entry. It remains fixed when the user travels. */
  readonly localDay: string;
  readonly occurredAt: number;
  readonly kg: number;
}

const millisPerDay = 24 * 60 * 60 * 1000;

function calendarDay(day: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const date = new Date(`${day}T00:00:00Z`);
    const millis = date.getTime();
    if (Number.isFinite(millis) && date.toISOString().slice(0, 10) === day) return millis;
  }
  throw new TypeError("Invalid weigh-in calendar day");
}

/** Each measured day contributes its latest reading to the trailing seven calendar days. */
export function sevenDayWeightAverage(
  through: string,
  weighIns: readonly WeighIn[],
): { kg: number | null; measuredDays: number } {
  const end = calendarDay(through);
  const start = end - 6 * millisPerDay;
  const latestByDay = new Map<string, WeighIn>();
  const seen = new Map<string, WeighIn>();
  for (const reading of weighIns) {
    const day = calendarDay(reading.localDay);
    if (day < start || day > end) continue;
    if (
      !Number.isFinite(reading.kg) ||
      reading.kg <= 0 ||
      !Number.isSafeInteger(reading.occurredAt) ||
      !Number.isFinite(new Date(reading.occurredAt).getTime())
    ) {
      throw new RangeError("A weigh-in needs a finite positive weight and an event time");
    }
    if (typeof reading.id !== "string" || reading.id.trim() === "") {
      throw new TypeError("A weigh-in needs an ID");
    }
    const sameId = seen.get(reading.id);
    if (
      sameId &&
      (sameId.localDay !== reading.localDay ||
        sameId.occurredAt !== reading.occurredAt ||
        sameId.kg !== reading.kg)
    ) {
      throw new TypeError("Weigh-ins with the same ID must describe the same reading");
    }
    seen.set(reading.id, reading);
    const previous = latestByDay.get(reading.localDay);
    if (
      !previous ||
      reading.occurredAt > previous.occurredAt ||
      (reading.occurredAt === previous.occurredAt && reading.id > previous.id)
    ) {
      latestByDay.set(reading.localDay, reading);
    }
  }

  const measuredDays = latestByDay.size;
  if (measuredDays < 2) return { kg: null, measuredDays };
  let kg = 0;
  let count = 0;
  const readings = [...latestByDay.values()].sort((a, b) => a.localDay.localeCompare(b.localDay));
  for (const reading of readings) {
    count += 1;
    kg += (reading.kg - kg) / count;
  }
  return { kg, measuredDays };
}
