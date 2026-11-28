export function isRecordId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Boolean(value.trim()) &&
    !value.includes("\0") &&
    !/[\uD800-\uDFFF]/u.test(value)
  );
}

export function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function isOccurredAt(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Number.isFinite(new Date(value).valueOf())
  );
}

export function isLocalDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
