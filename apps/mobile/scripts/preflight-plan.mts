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
    typeof input.forceBuild !== "boolean" ||
    typeof input.message !== "string" ||
    !input.message
  ) {
    throw new Error("Invalid Edo Preflight planning evidence.");
  }
  if (delivered && !input.forceBuild) return { action: "ota", ...delivered };

  for (const build of input.builds) {
    if (
      !matchesPreflightStoreBuild(build, input.runtime) ||
      (input.forceBuild && build.message !== input.message)
    ) {
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
    return { action: apple || submitted ? "verify-delivery" : "submit", ...identity };
  }
  return { action: "build" };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(planPreflight(JSON.parse(readFileSync(0, "utf8")) as PlanInput)));
  } catch {
    console.error("Could not plan an Edo iOS Preflight release from the supplied evidence.");
    process.exitCode = 1;
  }
}
