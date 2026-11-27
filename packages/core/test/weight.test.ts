import { expect, it } from "vitest";
import { sevenDayWeightAverage, type WeighIn } from "../src/index.ts";

function reading(id: string, localDay: string, instant: string, kg: number): WeighIn {
  return { id, localDay, occurredAt: Date.parse(instant), kg };
}

it("uses seven calendar days and the most recent reading within each measured day", () => {
  const values = [
    reading("older", "2024-03-05", "2024-03-05T15:00:00Z", 110),
    reading("first", "2024-03-06", "2024-03-06T15:00:00Z", 82),
    reading("earlier", "2024-03-10", "2024-03-10T08:00:00Z", 90),
    reading("later", "2024-03-10", "2024-03-10T10:00:00Z", 81),
    // A travel entry retains the local day recorded with it, even if its UTC date is later.
    reading("travel", "2024-03-12", "2024-03-13T04:00:00Z", 80),
    reading("future", "2024-03-13", "2024-03-13T17:00:00Z", 120),
  ];
  const expected = { kg: 81, measuredDays: 3 };
  expect(sevenDayWeightAverage("2024-03-12", values)).toEqual(expected);
  expect(sevenDayWeightAverage("2024-03-12", values.toReversed())).toEqual(expected);
});

it("handles gaps without inventing measurements and validates the displayed date", () => {
  const leapDay = reading("leap-day", "2024-02-29", "2024-02-29T15:00:00Z", 80);
  expect(sevenDayWeightAverage("2024-03-06", [leapDay])).toEqual({ kg: null, measuredDays: 1 });
  expect(sevenDayWeightAverage("2024-03-07", [leapDay])).toEqual({ kg: null, measuredDays: 0 });
  expect(() => sevenDayWeightAverage("2023-02-29", [leapDay])).toThrow(/calendar day/i);
});

it("uses the same reading on timestamp ties regardless of input order", () => {
  const instant = "2024-03-12T08:00:00Z";
  const morning = reading("a", "2024-03-12", instant, 81);
  const laterId = reading("b", "2024-03-12", instant, 80);
  const previous = reading("previous", "2024-03-11", "2024-03-11T08:00:00Z", 82);
  const values = [previous, morning, laterId, { ...laterId }];
  expect(sevenDayWeightAverage("2024-03-12", values)).toEqual({ kg: 81, measuredDays: 2 });
  expect(sevenDayWeightAverage("2024-03-12", values.toReversed())).toEqual({
    kg: 81,
    measuredDays: 2,
  });
  expect(() => sevenDayWeightAverage("2024-03-12", [laterId, { ...laterId, kg: 79 }])).toThrow(
    /same ID/,
  );
});
