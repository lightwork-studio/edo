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
const submission = {
  status: "FINISHED",
  platform: "IOS",
  app: build.app,
  iosConfig: { ascAppIdentifier: "6840244969" },
  submittedBuild: { id: build.id },
};
const receipt = {
  id: "86848d23-8f82-437a-8bb3-43a06c083d91",
  marketingVersion: "0.1.0",
  buildNumber: "3",
  platform: "IOS",
  processingState: "VALID",
  internalBuildState: "IN_BETA_TESTING",
  expired: false,
  expirationDate: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
};
const evidence = {
  runtime,
  builds: [build],
  submissions: [submission],
  testFlight: {
    appStoreAppId: "6840244969",
    group: "Archive Restore",
    groupId: "cea7ca9a-9d7a-4089-9d81-46be7dbe9ac9",
    isInternalGroup: true,
    observedAt: Date.now(),
    memberBuildIds: [receipt.id],
    builds: [receipt],
  },
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
  expect(
    findDeliveredPreflightBuild({
      ...evidence,
      submissions: [{ ...submission, iosConfig: { ascAppIdentifier: "123456789" } }],
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
    { expirationDate: "2020-01-01T00:00:00Z" },
    { expirationDate: "invalid-date" },
    { expirationDate: "2099" },
    { expirationDate: "2099-02-30T00:00:00Z" },
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

test("rejects stale TestFlight evidence even if the stored receipt was active", () => {
  expect(() =>
    findDeliveredPreflightBuild({
      ...evidence,
      testFlight: { ...evidence.testFlight, observedAt: Date.now() - 10 * 60_000 },
    }),
  ).toThrow("Invalid Edo Preflight delivery evidence.");
});

test("fails closed for evidence from a different app or TestFlight group", () => {
  for (const wrong of [
    { appStoreAppId: "123456789" },
    { group: "Public beta" },
    { groupId: "dfecd1e1-9a43-41a8-b75b-3c0bdd36d68a" },
    { isInternalGroup: false },
  ]) {
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

test("requires Apple membership of the exact build record", () => {
  expect(
    findDeliveredPreflightBuild({
      ...evidence,
      testFlight: {
        ...evidence.testFlight,
        memberBuildIds: ["e045236a-74cc-4e5f-b559-1094e266d573"],
      },
    }),
  ).toBeNull();
});

test("accepts Apple offsets and opaque resource IDs with exact membership", () => {
  const id = "AppleBuildResource-ABC";
  const buildReceipt = { ...receipt, id, expirationDate: "2099-02-28T17:30:00.123-08:00" };
  expect(
    findDeliveredPreflightBuild({
      ...evidence,
      testFlight: { ...evidence.testFlight, memberBuildIds: [id], builds: [buildReceipt] },
    }),
  ).toMatchObject({ buildId: build.id });
});

test("rejects malformed versions even when both providers report the same values", () => {
  expect(
    findDeliveredPreflightBuild({
      ...evidence,
      builds: [{ ...build, appVersion: "malformed", appBuildVersion: "  " }],
      testFlight: {
        ...evidence.testFlight,
        builds: [{ ...receipt, marketingVersion: "malformed", buildNumber: "  " }],
      },
    }),
  ).toBeNull();
});
