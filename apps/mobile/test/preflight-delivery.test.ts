import { expect, test } from "vitest";
import { findDeliveredPreflightBuild } from "../scripts/preflight-delivery.mts";

const runtime = "a".repeat(40);
const build = {
  id: "719fd3d0-36c3-4a54-8015-febf597839a8",
  app: { id: "fd9dba15-d0b8-4594-a2b0-aed4cc0a0b7a" },
  appIdentifier: "studio.lightwork.edo",
  appVersion: "0.1.0",
  appBuildVersion: "3",
  platform: "IOS",
  distribution: "STORE",
  isForIosSimulator: false,
  status: "FINISHED",
  runtime: { version: runtime },
  updateChannel: { name: "preflight" },
};
const submission = { status: "FINISHED", platform: "IOS", submittedBuild: { id: build.id } };
const receipt = {
  marketingVersion: "0.1.0",
  buildNumber: "3",
  platform: "IOS",
  processingState: "VALID",
  internalBuildState: "IN_BETA_TESTING",
  expired: false,
};
const evidence = {
  runtime,
  builds: [build],
  submissions: [submission],
  testFlight: { appStoreAppId: "6840244969", group: "Archive Restore", builds: [receipt] },
};

test("confirms a finished EAS build that reached the exact internal TestFlight group", () => {
  expect(findDeliveredPreflightBuild(evidence)).toEqual({
    buildId: build.id,
    marketingVersion: build.appVersion,
    buildNumber: build.appBuildVersion,
  });
});

test("withholds readiness when the binary or its submission has not succeeded", () => {
  for (const status of ["NEW", "IN_QUEUE", "IN_PROGRESS", "ERRORED", "CANCELED"]) {
    expect(findDeliveredPreflightBuild({ ...evidence, builds: [{ ...build, status }] })).toBeNull();
  }
  for (const status of ["AWAITING_BUILD", "IN_QUEUE", "IN_PROGRESS", "ERRORED", "CANCELED"]) {
    expect(
      findDeliveredPreflightBuild({ ...evidence, submissions: [{ ...submission, status }] }),
    ).toBeNull();
  }
  expect(findDeliveredPreflightBuild({ ...evidence, submissions: [] })).toBeNull();
  expect(
    findDeliveredPreflightBuild({
      ...evidence,
      submissions: [{ ...submission, submittedBuild: { id: "a-different-eas-build" } }],
    }),
  ).toBeNull();
});

test("requires the exact app, platform, store distribution, channel and runtime", () => {
  for (const wrong of [
    { app: { id: "another-project" } },
    { appIdentifier: "studio.lightwork.other" },
    { platform: "ANDROID" },
    { distribution: "INTERNAL" },
    { isForIosSimulator: true },
    { updateChannel: { name: "production" } },
    { runtime: { version: "b".repeat(40) } },
    { runtime: null },
  ]) {
    expect(
      findDeliveredPreflightBuild({ ...evidence, builds: [{ ...build, ...wrong }] }),
    ).toBeNull();
  }
});

test("rejects expired, processing and mismatched TestFlight receipts", () => {
  for (const wrong of [
    { processingState: "PROCESSING" },
    { internalBuildState: "MISSING_EXPORT_COMPLIANCE" },
    { internalBuildState: "READY_FOR_BETA_TESTING" },
    { expired: true },
    { platform: "MAC_OS" },
    { marketingVersion: "0.2.0" },
    { buildNumber: "2" },
  ]) {
    expect(
      findDeliveredPreflightBuild({
        ...evidence,
        testFlight: { ...evidence.testFlight, builds: [{ ...receipt, ...wrong }] },
      }),
    ).toBeNull();
  }
  expect(
    findDeliveredPreflightBuild({
      ...evidence,
      testFlight: { ...evidence.testFlight, builds: [] },
    }),
  ).toBeNull();
});

test("fails closed for evidence from a different app or TestFlight group", () => {
  for (const wrong of [{ appStoreAppId: "123456789" }, { group: "Public beta" }]) {
    expect(() =>
      findDeliveredPreflightBuild({
        ...evidence,
        testFlight: { ...evidence.testFlight, ...wrong },
      }),
    ).toThrow("Invalid Edo Preflight delivery evidence.");
  }
  expect(() => findDeliveredPreflightBuild({ ...evidence, runtime: "" })).toThrow(
    "Invalid Edo Preflight delivery evidence.",
  );
});
