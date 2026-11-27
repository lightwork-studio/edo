export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export const syncErrorCodes = [
  "invalid-request",
  "unauthorized",
  "update-required",
  "write-disabled",
  "account-changed",
  "lineage-changed",
  "cursor-reset",
  "unavailable",
] as const;
export type SyncErrorCode = (typeof syncErrorCodes)[number];

export class SyncWireError extends Error {
  readonly code: SyncErrorCode;

  constructor(code: SyncErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "SyncWireError";
  }
}

export function invalid(field: string): never {
  throw new SyncWireError("invalid-request", `Invalid sync ${field}`);
}

export function fields(value: unknown, field: string, allowed?: readonly string[]) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid(field);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid(field);
  for (const name of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, name);
    if (
      typeof name !== "string" ||
      (allowed && !allowed.includes(name)) ||
      !property?.enumerable ||
      !("value" in property)
    ) {
      return invalid(field);
    }
  }
  return value as Record<string, unknown>;
}

export function choice<const Choices extends readonly string[]>(
  value: unknown,
  choices: Choices,
  field: string,
): Choices[number] {
  if (typeof value !== "string" || !choices.includes(value)) return invalid(field);
  return value;
}

export function safeInteger(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    return invalid(field);
  }
  return value;
}

export function readText(value: unknown, max: number, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) return invalid(field);
  return value;
}

/** Match the storage ID rules so conversion through SQLite does not alias two identities. */
export function readId(value: unknown, field: string): string {
  const id = readText(value, 1024, field);
  if (id.includes("\0") || /[\ud800-\udfff]/u.test(id)) return invalid(field);
  return id;
}

export function readList<T>(
  value: unknown,
  max: number,
  field: string,
  read: (item: unknown) => T,
): T[] {
  if (!Array.isArray(value) || value.length > max) return invalid(field);
  if (Reflect.ownKeys(value).length !== value.length + 1) return invalid(field);
  const result: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(value, index);
    if (!item?.enumerable || !("value" in item)) return invalid(field);
    result.push(read(item.value));
  }
  return result;
}

/** A finite-depth, side-effect-free copy that preserves unknown own JSON keys. */
export function readContent(value: unknown): JsonObject {
  const body = fields(value, "record content");
  const maxValues = 50_000;
  let remaining = maxValues;

  function read(value: unknown, depth: number): JsonValue {
    remaining -= 1;
    if (remaining < 0 || depth > 40) return invalid("record content size or depth");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
      return readList(value, remaining, "record content array", (entry) => read(entry, depth + 1));
    }
    return readObject(fields(value, "record content value"), depth);
  }

  function readObject(value: Record<string, unknown>, depth: number): JsonObject {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, read(entry, depth + 1)]),
    );
  }

  return readObject(body, 0);
}
