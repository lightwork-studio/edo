import { createPrivateKey, sign } from "node:crypto";
import { appStoreApp, preflightGroup, preflightGroupId } from "./preflight-delivery.mts";

const appleOrigin = "https://api.appstoreconnect.apple.com";
type AppleReference = { readonly id: string; readonly type: string };
type AppleRecord<T> = AppleReference & {
  readonly attributes: T;
  readonly relationships?: Record<string, { readonly data?: AppleReference | null }>;
};
type RelatedBuildDetails = {
  readonly version?: string;
  readonly platform?: string;
  readonly internalBuildState?: string;
};
type AppleList<T> = {
  readonly data: readonly AppleRecord<T>[];
  readonly included?: readonly AppleRecord<RelatedBuildDetails>[];
  readonly links?: { readonly next?: string | null };
};

function appStoreToken() {
  const { ASC_API_KEY_P8, ASC_API_KEY_ID, ASC_API_ISSUER_ID } = process.env;
  if (!ASC_API_KEY_P8 || !ASC_API_KEY_ID || !ASC_API_ISSUER_ID) {
    throw new Error("App Store Connect credentials are required.");
  }
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "ES256", kid: ASC_API_KEY_ID, typ: "JWT" });
  const claims = encode({
    iss: ASC_API_ISSUER_ID,
    iat: now,
    exp: now + 600,
    aud: "appstoreconnect-v1",
  });
  const unsigned = `${header}.${claims}`;
  const key = createPrivateKey(ASC_API_KEY_P8.replaceAll("\\n", "\n").trim());
  const signature = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" });
  return `${unsigned}.${signature.toString("base64url")}`;
}

export async function readPreflightTestFlight() {
  const observedAt = Date.now();
  const token = appStoreToken();

  function appleUrl(path: string, params: Record<string, string> = {}) {
    const url = new URL(path, appleOrigin);
    if (url.origin !== appleOrigin) throw new Error("Invalid App Store Connect response URL.");
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    return url;
  }

  async function get<T>(url: URL): Promise<T> {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(`App Store Connect request failed with HTTP ${response.status}.`);
    }
    return (await response.json()) as T;
  }

  async function list<T>(path: string, fields: Record<string, string>) {
    let url: URL | null = appleUrl(path, { ...fields, limit: "50" });
    const seen = new Set<string>();
    const rows: AppleRecord<T>[] = [];
    const related = new Map<string, RelatedBuildDetails>();
    while (url) {
      if (seen.has(url.href)) throw new Error("Invalid App Store Connect pagination.");
      seen.add(url.href);
      const page: AppleList<T> = await get<AppleList<T>>(url);
      rows.push(...page.data);
      for (const { id, type, attributes } of page.included ?? []) {
        related.set(`${type}:${id}`, attributes);
      }
      url = page.links?.next ? appleUrl(page.links.next) : null;
    }
    return { rows, related };
  }

  const { rows: groups } = await list<{
    name: string;
    isInternalGroup: boolean;
    hasAccessToAllBuilds: boolean;
  }>(`/v1/apps/${appStoreApp}/betaGroups`, {
    "fields[betaGroups]": "name,isInternalGroup,hasAccessToAllBuilds",
  });
  const selected = groups.filter(
    ({ id, attributes }) =>
      id === preflightGroupId && attributes.isInternalGroup && attributes.name === preflightGroup,
  );
  const group = selected[0];
  if (
    !group ||
    selected.length !== 1 ||
    groups.some(({ id, attributes }) => id !== group.id && attributes.hasAccessToAllBuilds)
  ) {
    throw new Error("Edo TestFlight group access differs from the Preflight configuration.");
  }
  const [members, appBuilds] = await Promise.all([
    list<Record<string, never>>(`/v1/betaGroups/${group.id}/builds`, {
      "fields[builds]": "version",
    }),
    list<{ version: string; processingState: string; expired: boolean; expirationDate: string }>(
      "/v1/builds",
      {
        "filter[app]": appStoreApp,
        include: "preReleaseVersion,buildBetaDetail",
        "fields[builds]":
          "version,processingState,expired,expirationDate,preReleaseVersion,buildBetaDetail",
        "fields[preReleaseVersions]": "version,platform",
        "fields[buildBetaDetails]": "internalBuildState",
      },
    ),
  ]);
  const memberIds = new Set(members.rows.map(({ id }) => id));
  const knownBuilds = [];
  const builds = [];
  for (const { id, attributes, relationships } of appBuilds.rows) {
    const releaseRef = relationships?.preReleaseVersion?.data;
    const release = releaseRef && appBuilds.related.get(`${releaseRef.type}:${releaseRef.id}`);
    if (!release?.version || !release.platform) {
      throw new Error("App Store Connect did not identify a build's platform and version.");
    }
    const build = {
      id,
      marketingVersion: release.version,
      buildNumber: attributes.version,
      platform: release.platform,
      processingState: attributes.processingState,
      expired: attributes.expired,
      expirationDate: attributes.expirationDate,
    };
    knownBuilds.push(build);
    if (memberIds.has(id) && !attributes.expired) {
      const detailRef = relationships?.buildBetaDetail?.data;
      const detail = detailRef && appBuilds.related.get(`${detailRef.type}:${detailRef.id}`);
      if (detail?.internalBuildState)
        builds.push({ ...build, internalBuildState: detail.internalBuildState });
    }
  }
  return {
    appStoreAppId: appStoreApp,
    group: preflightGroup,
    groupId: group.id,
    isInternalGroup: group.attributes.isInternalGroup,
    observedAt,
    memberBuildIds: [...memberIds],
    knownBuilds,
    builds,
  };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await readPreflightTestFlight()));
  } catch {
    console.error("Could not verify Edo's internal TestFlight delivery.");
    process.exitCode = 1;
  }
}
