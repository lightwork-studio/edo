import { expect, test } from "vitest";
import { matchLibraryName } from "../src/food-library.ts";

test("matches accent-insensitive library names with search terms in any order", () => {
  const matches = matchLibraryName("  MUS apfel ", "de-DE");

  expect(matches?.("Äpfelmus selbstgemacht")).toBe(true);
  expect(matches?.("Müsli mit Apfel")).toBe(true);
  expect(matches?.("Apfelsaft")).toBe(false);
  expect(matches?.("Müsli")).toBe(false);
});

test("keeps the complete library visible without a search term", () => {
  expect(matchLibraryName("  \t\n ", "en-US")).toBeUndefined();
});
