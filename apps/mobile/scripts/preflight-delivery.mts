import { readFileSync } from "node:fs";

const expoProject = "fd9dba15-d0b8-4594-a2b0-aed4cc0a0b7a";
const iosBundle = "studio.lightwork.edo";
const preflightChannel = "preflight";
const appStoreApp = "6840244969";
const preflightGroup = "Archive Restore";
const preflightGroupId = "cea7ca9a-9d7a-4089-9d81-46be7dbe9ac9";
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const maxReceiptAgeMs = 5 * 60_000;

type ExpoBuild = {
  readonly id: string;
  readonly app?: { readonly id?: string };
  readonly appIdentifier?: string;
  readonly appVersion?: string;
  readonly appBuildVersion?: string;
  readonly platform: string;
  readonly distribution?: string;
  readonly isForIosSimulator?: boolean;
  readonly status: string;
  readonly runtime?: { readonly version?: string } | null;
  readonly updateChannel?: { readonly name?: string } | null;
};

type ExpoSubmission = {
  readonly status: string;
  readonly platform: string;
  readonly app?: { readonly id?: string };
  readonly iosConfig?: { readonly ascAppIdentifier?: string };
  readonly submittedBuild?: { readonly id?: string } | null;
};

type TestFlightBuild = {
  readonly id: string;
  readonly marketingVersion: string;
  readonly buildNumber: string;
  readonly platform: string;
  readonly processingState: string;
  readonly internalBuildState: string;
  readonly expired: boolean;
  readonly expirationDate: string;
};

type DeliveryEvidence = {
  readonly runtime: string;
  readonly builds: readonly ExpoBuild[];
  readonly submissions: readonly ExpoSubmission[];
  readonly testFlight: {
    readonly appStoreAppId: string;
    readonly group: string;
    readonly groupId: string;
    readonly isInternalGroup: boolean;
    readonly observedAt: number;
    readonly memberBuildIds: readonly string[];
    readonly builds: readonly TestFlightBuild[];
  };
};

function unexpired(value: unknown, now: number) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      value,
    )
  ) {
    return false;
  }
  const day = value.slice(0, 10);
  const midnight = Date.parse(`${day}T00:00:00Z`);
  return (
    Number.isFinite(midnight) &&
    new Date(midnight).toISOString().startsWith(day) &&
    Date.parse(value) > now
  );
}

/** Match fresh provider responses fetched by the authenticated release jobs. */
export function findDeliveredPreflightBuild(evidence: DeliveryEvidence) {
  const { runtime, builds, submissions, testFlight } = evidence;
  const now = Date.now();
  if (
    typeof runtime !== "string" ||
    !/^[0-9a-f]{40}$/.test(runtime) ||
    testFlight?.appStoreAppId !== appStoreApp ||
    testFlight.group !== preflightGroup ||
    testFlight.groupId !== preflightGroupId ||
    testFlight.isInternalGroup !== true ||
    !Number.isFinite(testFlight.observedAt) ||
    testFlight.observedAt > now + 30_000 ||
    now - testFlight.observedAt > maxReceiptAgeMs ||
    !Array.isArray(builds) ||
    !Array.isArray(submissions) ||
    !Array.isArray(testFlight.memberBuildIds) ||
    !Array.isArray(testFlight.builds)
  ) {
    throw new Error("Invalid Edo Preflight delivery evidence.");
  }

  const members = new Set(testFlight.memberBuildIds);
  for (const build of builds) {
    if (
      build?.status !== "FINISHED" ||
      build.platform !== "IOS" ||
      build.distribution !== "STORE" ||
      build.isForIosSimulator !== false ||
      build.app?.id !== expoProject ||
      build.appIdentifier !== iosBundle ||
      build.runtime?.version !== runtime ||
      build.updateChannel?.name !== preflightChannel ||
      typeof build.id !== "string" ||
      !uuid.test(build.id) ||
      typeof build.appVersion !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(build.appVersion) ||
      typeof build.appBuildVersion !== "string" ||
      !/^\d+(?:\.\d+){0,2}$/.test(build.appBuildVersion)
    ) {
      continue;
    }

    const submitted = submissions.some(
      (submission) =>
        submission?.status === "FINISHED" &&
        submission.platform === "IOS" &&
        submission.app?.id === expoProject &&
        submission.iosConfig?.ascAppIdentifier === appStoreApp &&
        submission.submittedBuild?.id === build.id,
    );
    const available = testFlight.builds.some(
      (receipt) =>
        receipt?.platform === "IOS" &&
        typeof receipt.id === "string" &&
        receipt.id.length > 0 &&
        members.has(receipt.id) &&
        receipt.processingState === "VALID" &&
        receipt.internalBuildState === "IN_BETA_TESTING" &&
        receipt.expired === false &&
        unexpired(receipt.expirationDate, now) &&
        receipt.marketingVersion === build.appVersion &&
        receipt.buildNumber === build.appBuildVersion,
    );
    if (submitted && available) {
      return {
        buildId: build.id,
        marketingVersion: build.appVersion,
        buildNumber: build.appBuildVersion,
      };
    }
  }
  return null;
}

if (import.meta.main) {
  try {
    const evidence = JSON.parse(readFileSync(0, "utf8")) as DeliveryEvidence;
    console.log(JSON.stringify(findDeliveredPreflightBuild(evidence)));
  } catch {
    console.error("Invalid Edo Preflight delivery evidence.");
    process.exitCode = 1;
  }
}
