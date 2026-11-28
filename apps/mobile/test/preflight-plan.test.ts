import { expect, test } from "vitest";
import { appStoreApp, preflightGroup, preflightGroupId } from "../scripts/preflight-delivery.mts";
import { planPreflight } from "../scripts/preflight-plan.mts";

const runtime = "a".repeat(40);
const app = { id: "fd9dba15-d0b8-4594-a2b0-aed4cc0a0b7a" };
const buildId = "e129cdf8-e236-4cad-96a4-305822754a20";
const build = {
  id: buildId,
  app,
  appIdentifier: "studio.lightwork.edo",
  appVersion: "0.1.0",
  appBuildVersion: "3",
  platform: "IOS",
  distribution: "STORE",
  isForIosSimulator: false,
  status: "FINISHED",
  runtime: { version: runtime },
  updateChannel: { name: "preflight" },
  message: "Edo Preflight aaaaaaaaaaaa (999)",
};
const submission = {
  app,
  platform: "IOS",
  status: "FINISHED",
  iosConfig: { ascAppIdentifier: appStoreApp },
  submittedBuild: { id: buildId },
};
const receipt = {
  id: "05243217-2785-4a99-a62f-7803966e6114",
  marketingVersion: "0.1.0",
  buildNumber: "3",
  platform: "IOS",
  processingState: "VALID",
  internalBuildState: "IN_BETA_TESTING",
  expired: false,
  expirationDate: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
};
const testFlight = {
  appStoreAppId: appStoreApp,
  group: preflightGroup,
  groupId: preflightGroupId,
  isInternalGroup: true,
  observedAt: Date.now(),
  memberBuildIds: [],
  builds: [],
  knownBuilds: [],
};
const input = {
  runtime,
  message: build.message,
  forceBuild: false,
  builds: [build],
  submissions: [],
  testFlight,
};

test("builds only when no matching signed or in-flight archive exists", () => {
  expect(planPreflight({ ...input, builds: [] })).toEqual({ action: "build" });
  expect(planPreflight({ ...input, builds: [{ ...build, status: "ERRORED" }] })).toEqual({
    action: "build",
  });
  expect(planPreflight({ ...input, builds: [{ ...build, status: "IN_QUEUE" }] })).toEqual({
    action: "wait-for-build",
    buildId,
  });
  expect(planPreflight(input)).toMatchObject({ action: "submit", buildId });
});

test("uses the exact archive after a failed submit and waits for ongoing or accepted uploads", () => {
  expect(
    planPreflight({ ...input, submissions: [{ ...submission, status: "ERRORED" }] }),
  ).toMatchObject({ action: "submit", buildId });
  for (const status of ["AWAITING_BUILD", "IN_QUEUE", "IN_PROGRESS", "FINISHED"]) {
    expect(planPreflight({ ...input, submissions: [{ ...submission, status }] })).toMatchObject({
      action: "verify-delivery",
      buildId,
    });
  }
  expect(
    planPreflight({
      ...input,
      testFlight: { ...testFlight, knownBuilds: [{ ...receipt, processingState: "PROCESSING" }] },
    }),
  ).toMatchObject({ action: "verify-delivery", buildId });
});

test("publishes OTA only after delivery and reserves a manual rebuild for its own run", () => {
  const delivered = {
    ...input,
    submissions: [submission],
    testFlight: {
      ...testFlight,
      memberBuildIds: [receipt.id],
      builds: [receipt],
      knownBuilds: [receipt],
    },
  };
  expect(planPreflight(delivered)).toMatchObject({ action: "ota", buildId });
  expect(planPreflight({ ...delivered, forceBuild: true, message: "another run" })).toEqual({
    action: "build",
  });
  expect(planPreflight({ ...delivered, forceBuild: true })).toMatchObject({
    action: "verify-delivery",
    buildId,
  });
  expect(
    planPreflight({
      ...input,
      submissions: [submission],
      testFlight: { ...testFlight, knownBuilds: [{ ...receipt, expired: true }] },
    }),
  ).toEqual({ action: "build" });
});
