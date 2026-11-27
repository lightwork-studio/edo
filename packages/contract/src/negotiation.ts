import {
  choice,
  fields,
  invalid,
  readId,
  readList,
  readText,
  SyncWireError,
  safeInteger,
} from "./wire-values.ts";

const revisionLimit = Number.MAX_SAFE_INTEGER;
const writeFeature = "write-records";
const tokenLimit = 64;
const negotiated = Symbol("Edo negotiated sync");
const sessions = new WeakSet<NegotiatedSync>();

export const recordKinds = [
  "meal",
  "custom-food",
  "recipe",
  "meal-template",
  "favorite",
  "weigh-in",
  "nutrition-target",
] as const;
export type RecordKind = (typeof recordKinds)[number];

export type Revision = number;

export interface SyncRelease {
  readonly release: string;
  readonly features: readonly string[];
  readonly writableKinds: readonly string[];
}

/** Local candidate. No released client or server depends on this definition. */
export const syncCandidate: SyncRelease = Object.freeze({
  release: "0.1",
  features: Object.freeze([writeFeature]),
  writableKinds: Object.freeze(recordKinds),
});

export interface HelloRequest {
  readonly releases: readonly string[];
  readonly features: readonly string[];
}

/** Server-supplied account state from the authenticated account, outside the request body. */
export interface AuthenticatedHistory {
  readonly accountBinding: string;
  readonly lineage: string;
  readonly revision: Revision;
  readonly restoredFrom: { readonly lineage: string; readonly revision: Revision } | null;
}

export interface HelloResponse extends AuthenticatedHistory {
  readonly release: string;
  readonly features: readonly string[];
}

export interface NegotiationRefused {
  readonly status: "update-required";
  readonly supportedReleases: readonly string[];
}

export interface NegotiatedSync extends HelloResponse {
  readonly [negotiated]: true;
  readonly writableKinds: readonly string[];
}

export type NegotiationResult =
  | { readonly status: "ready"; readonly response: HelloResponse; readonly session: NegotiatedSync }
  | NegotiationRefused;

export function readRevision(value: unknown, field: string, allowZero = false): Revision {
  return safeInteger(value, allowZero ? 0 : 1, revisionLimit, field);
}

function releaseName(value: unknown): string {
  const name = readText(value, 16, "release");
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(name)) return invalid("release");
  return name;
}

export function readToken(value: unknown, field: string): string {
  const token = readText(value, tokenLimit, field);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(token)) return invalid(field);
  return token;
}

function uniqueNames(value: unknown, read: (entry: unknown) => string, field: string) {
  const names = readList(value, tokenLimit, field, read);
  if (new Set(names).size !== names.length) return invalid(field);
  return names;
}

function supportedReleaseList(value: unknown) {
  const releases = uniqueNames(value, releaseName, "releases");
  if (!releases.length) return invalid("releases");
  return releases;
}

function features(value: unknown): string[] {
  return uniqueNames(value, (entry) => readToken(entry, "feature"), "features");
}

export function decodeHelloRequest(input: unknown): HelloRequest {
  const body = fields(input, "hello request", ["releases", "features"]);
  return { releases: supportedReleaseList(body.releases), features: features(body.features) };
}

function readHistory(body: Record<string, unknown>): AuthenticatedHistory {
  const accountBinding = readId(body.accountBinding, "account binding");
  const lineage = readId(body.lineage, "lineage");
  const revision = readRevision(body.revision, "account revision", true);
  let restoredFrom: AuthenticatedHistory["restoredFrom"] = null;
  if (body.restoredFrom !== null) {
    const from = fields(body.restoredFrom, "restore point", ["lineage", "revision"]);
    const priorLineage = readId(from.lineage, "prior lineage");
    const priorRevision = readRevision(from.revision, "prior revision", true);
    if (priorLineage === lineage || priorRevision > revision) return invalid("restore point");
    restoredFrom = Object.freeze({ lineage: priorLineage, revision: priorRevision });
  }
  return { accountBinding, lineage, revision, restoredFrom };
}

export function decodeHelloResponse(input: unknown): HelloResponse {
  const body = fields(input, "hello response", [
    "release",
    "features",
    "accountBinding",
    "lineage",
    "revision",
    "restoredFrom",
  ]);
  return {
    release: releaseName(body.release),
    features: features(body.features),
    ...readHistory(body),
  };
}

export function decodeNegotiationRefused(input: unknown): NegotiationRefused {
  const body = fields(input, "negotiation refusal", ["status", "supportedReleases"]);
  return {
    status: choice(body.status, ["update-required"], "negotiation status"),
    supportedReleases: supportedReleaseList(body.supportedReleases),
  };
}

function sessionFor(response: HelloResponse, release: SyncRelease): NegotiatedSync {
  const session = Object.freeze({
    ...response,
    features: Object.freeze([...response.features]),
    [negotiated]: true as const,
    writableKinds: Object.freeze([...release.writableKinds]),
  });
  sessions.add(session);
  return session;
}

/** Supported releases are listed in server preference order. */
export function negotiateHello(
  input: unknown,
  identity: AuthenticatedHistory,
  releases: readonly SyncRelease[] = [syncCandidate],
): NegotiationResult {
  const hello = decodeHelloRequest(input);
  const supportedReleases = supportedReleaseList(releases.map(({ release }) => release));
  const selected = releases.find(({ release }) => hello.releases.includes(release));
  if (!selected) return { status: "update-required", supportedReleases };
  const response = decodeHelloResponse({
    release: selected.release,
    features: selected.features.filter((feature) => hello.features.includes(feature)),
    accountBinding: identity.accountBinding,
    lineage: identity.lineage,
    revision: identity.revision,
    restoredFrom: identity.restoredFrom,
  });
  return { status: "ready", response, session: sessionFor(response, selected) };
}

/** Review a changed binding or lineage before accepting it as the source of uploads. */
export function acceptHello(
  request: HelloRequest,
  input: unknown,
  previous?: Pick<AuthenticatedHistory, "accountBinding" | "lineage">,
  releases: readonly SyncRelease[] = [syncCandidate],
): NegotiatedSync {
  const hello = decodeHelloRequest(request);
  const response = decodeHelloResponse(input);
  const release = releases.find(({ release }) => release === response.release);
  if (!release || !hello.releases.includes(response.release)) {
    throw new SyncWireError("update-required", "The sync release was not offered by this client");
  }
  if (
    response.features.some(
      (feature) => !hello.features.includes(feature) || !release.features.includes(feature),
    )
  ) {
    return invalid("negotiated features");
  }
  if (previous && response.accountBinding !== previous.accountBinding) {
    throw new SyncWireError("account-changed", "The authenticated sync account changed");
  }
  if (previous && response.lineage !== previous.lineage) {
    throw new SyncWireError("lineage-changed", "The authenticated account history changed");
  }
  return sessionFor(response, release);
}

export function assertSession(session: NegotiatedSync, write = false): void {
  if (!sessions.has(session)) {
    throw new SyncWireError("update-required", "Sync release negotiation is required");
  }
  if (write && !session.features.includes(writeFeature)) {
    throw new SyncWireError("write-disabled", "Account record writes were not negotiated");
  }
}
