import { readFileSync } from "node:fs";
import {
  type DeliveryEvidence,
  describePreflightBuild,
  findDeliveredPreflightBuild,
  matchesPreflightStoreBuild,
  type TestFlightBuild,
  targetsPreflightSubmission,
} from "./preflight-delivery.mts";

type SubmissionEvidence = Omit<TestFlightBuild, "internalBuildState">;
type PlanInput = DeliveryEvidence & {
  readonly revision: string;
  readonly nativeBuildIds: readonly string[];
  readonly forceBuild: boolean;
  readonly message: string;
  readonly testFlight: DeliveryEvidence["testFlight"] & {
    readonly knownBuilds: readonly SubmissionEvidence[];
  };
};

const activeBuilds = new Set(["NEW", "IN_QUEUE", "IN_PROGRESS"]);
const activeSubmissions = new Set(["AWAITING_BUILD", "IN_QUEUE", "IN_PROGRESS", "FINISHED"]);

export function planPreflight(input: PlanInput) {
  const delivered = findDeliveredPreflightBuild(input);
  if (
    !Array.isArray(input.testFlight.knownBuilds) ||
    typeof input.revision !== "string" ||
    !/^[0-9a-f]{40}$/.test(input.revision) ||
    !Array.isArray(input.nativeBuildIds) ||
    typeof input.forceBuild !== "boolean" ||
    typeof input.message !== "string" ||
    !input.message
  ) {
    throw new Error("Invalid Edo Preflight planning evidence.");
  }
  if (delivered && !input.forceBuild) return { action: "ota", ...delivered };

  const trusted = new Set(input.nativeBuildIds);
  let unattested = false;
  for (const build of input.builds) {
    if (
      !matchesPreflightStoreBuild(build, input.runtime) ||
      build.gitCommitHash !== input.revision ||
      build.buildProfile !== "preflight" ||
      (input.forceBuild && build.message !== input.message)
    ) {
      continue;
    }
    const expiredArchive = Boolean(
      build.expirationDate && Date.parse(build.expirationDate) <= Date.now(),
    );
    if ((activeBuilds.has(build.status) || build.status === "FINISHED") && !trusted.has(build.id)) {
      if (!expiredArchive) unattested = true;
      continue;
    }
    if (activeBuilds.has(build.status)) return { action: "wait-for-build", buildId: build.id };
    if (build.status !== "FINISHED" || build.isForIosSimulator !== false) continue;

    const identity = describePreflightBuild(build);
    if (!identity) throw new Error("Missing iOS version for the exact Preflight build.");
    const apple = input.testFlight.knownBuilds.find(
      (receipt) =>
        receipt?.platform === "IOS" &&
        receipt.marketingVersion === identity.marketingVersion &&
        receipt.buildNumber === identity.buildNumber,
    );
    if (apple?.expired === true && !input.forceBuild) continue;
    const submitted = input.submissions.some(
      (submission) =>
        targetsPreflightSubmission(submission, identity.buildId) &&
        activeSubmissions.has(submission.status),
    );
    if (apple?.processingState === "FAILED" || apple?.processingState === "INVALID") {
      throw new Error(
        "Apple rejected this archive. Resolve that issue before dispatching force_build.",
      );
    }
    if (!apple && !submitted && expiredArchive) {
      continue;
    }
    if (
      !submitted &&
      input.testFlight.builds.some(
        (receipt) =>
          receipt?.platform === "IOS" &&
          receipt.processingState === "VALID" &&
          receipt.internalBuildState === "IN_BETA_TESTING" &&
          receipt.marketingVersion === identity.marketingVersion &&
          receipt.buildNumber === identity.buildNumber,
      )
    ) {
      throw new Error(
        "Apple has the build but EAS delivery is unconfirmed. Inspect both records before dispatching force_build.",
      );
    }
    return { action: apple || submitted ? "verify-delivery" : "submit", ...identity };
  }
  if (unattested) {
    throw new Error(
      "An EAS build exists without a verified native handoff. Inspect its publishing run before retrying.",
    );
  }
  return { action: "build" };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(planPreflight(JSON.parse(readFileSync(0, "utf8")) as PlanInput)));
  } catch (error) {
    if (
      error instanceof Error &&
      /^(Apple rejected|Apple has the build|An EAS build exists)/.test(error.message)
    ) {
      console.error(error.message);
    } else {
      console.error("Could not plan an Edo iOS Preflight release from the supplied evidence.");
    }
    process.exitCode = 1;
  }
}
