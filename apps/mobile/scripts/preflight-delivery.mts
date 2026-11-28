import { readFileSync } from "node:fs";

const expoProject = "fd9dba15-d0b8-4594-a2b0-aed4cc0a0b7a";
const iosBundle = "studio.lightwork.edo";
const preflightChannel = "preflight";
const appStoreApp = "6840244969";
const preflightGroup = "Archive Restore";
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

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
  readonly submittedBuild?: { readonly id?: string } | null;
};

type TestFlightBuild = {
  readonly marketingVersion: string;
  readonly buildNumber: string;
  readonly platform: string;
  readonly processingState: string;
  readonly internalBuildState: string;
  readonly expired: boolean;
};

type DeliveryEvidence = {
  readonly runtime: string;
  readonly builds: readonly ExpoBuild[];
  readonly submissions: readonly ExpoSubmission[];
  readonly testFlight: {
    readonly appStoreAppId: string;
    readonly group: string;
    readonly builds: readonly TestFlightBuild[];
  };
};

/** A runtime can receive OTA once its signed binary is available to the intended testers. */
export function findDeliveredPreflightBuild(evidence: DeliveryEvidence) {
  const { runtime, builds, submissions, testFlight } = evidence;
  if (
    typeof runtime !== "string" ||
    !/^[0-9a-f]{40}$/.test(runtime) ||
    testFlight?.appStoreAppId !== appStoreApp ||
    testFlight.group !== preflightGroup ||
    !Array.isArray(builds) ||
    !Array.isArray(submissions) ||
    !Array.isArray(testFlight.builds)
  ) {
    throw new Error("Invalid Edo Preflight delivery evidence.");
  }

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
      !build.appVersion ||
      typeof build.appBuildVersion !== "string" ||
      !build.appBuildVersion
    ) {
      continue;
    }

    const submitted = submissions.some(
      (submission) =>
        submission?.status === "FINISHED" &&
        submission.platform === "IOS" &&
        submission.submittedBuild?.id === build.id,
    );
    const available = testFlight.builds.some(
      (receipt) =>
        receipt?.platform === "IOS" &&
        receipt.processingState === "VALID" &&
        receipt.internalBuildState === "IN_BETA_TESTING" &&
        receipt.expired === false &&
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
