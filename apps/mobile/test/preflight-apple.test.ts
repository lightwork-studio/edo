import { generateKeyPairSync } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { readPreflightTestFlight } from "../scripts/preflight-apple.mts";
import { appStoreApp, preflightGroup, preflightGroupId } from "../scripts/preflight-delivery.mts";

const group = {
  id: preflightGroupId,
  type: "betaGroups",
  attributes: { name: preflightGroup, isInternalGroup: true, hasAccessToAllBuilds: false },
};
const release = {
  id: "release-sample",
  type: "preReleaseVersions",
  attributes: { version: "0.1.0", platform: "IOS" },
};
const detail = {
  id: "beta-detail-sample",
  type: "buildBetaDetails",
  attributes: { internalBuildState: "IN_BETA_TESTING" },
};
const build = {
  id: "apple-build-sample",
  type: "builds",
  relationships: {
    preReleaseVersion: { data: { id: release.id, type: release.type } },
    buildBetaDetail: { data: { id: detail.id, type: detail.type } },
  },
  attributes: {
    version: "3",
    processingState: "VALID",
    expired: false,
    expirationDate: "2099-02-28T17:30:00.123-08:00",
  },
};

function stubCredentials() {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  vi.stubEnv("ASC_API_KEY_P8", privateKey);
  vi.stubEnv("ASC_API_KEY_ID", "test-key");
  vi.stubEnv("ASC_API_ISSUER_ID", "test-issuer");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("joins the app's build versions, build state and exact internal group membership", async () => {
  stubCredentials();
  const request = vi.fn(async (input: URL, init: RequestInit) => {
    expect(input.origin).toBe("https://api.appstoreconnect.apple.com");
    expect(init.redirect).toBe("error");
    if (input.pathname === `/v1/apps/${appStoreApp}/betaGroups`) {
      return Response.json({ data: [group] });
    }
    if (input.pathname === `/v1/betaGroups/${preflightGroupId}/builds`) {
      return Response.json({ data: [{ id: build.id, type: "builds" }] });
    }
    if (input.pathname === "/v1/builds") {
      expect(input.searchParams.get("filter[app]")).toBe(appStoreApp);
      expect(input.searchParams.get("include")).toBe("preReleaseVersion,buildBetaDetail");
      return Response.json({
        data: [
          build,
          {
            ...build,
            id: "already-uploaded-without-membership",
            attributes: { ...build.attributes, version: "4" },
          },
        ],
        included: [release, detail],
      });
    }
    throw new Error("Unexpected Apple request");
  });
  vi.stubGlobal("fetch", request);
  const result = await readPreflightTestFlight();
  expect(result.memberBuildIds).toEqual([build.id]);
  expect(result.builds).toEqual([
    expect.objectContaining({
      id: build.id,
      buildNumber: "3",
      internalBuildState: "IN_BETA_TESTING",
    }),
  ]);
  expect(result.knownBuilds.map(({ buildNumber }) => buildNumber)).toEqual(["3", "4"]);
  expect(request).toHaveBeenCalledTimes(3);
});

test("stops if a different TestFlight group automatically receives the same builds", async () => {
  stubCredentials();
  const request = vi.fn(async () =>
    Response.json({
      data: [
        group,
        {
          ...group,
          id: "another-group",
          attributes: { ...group.attributes, hasAccessToAllBuilds: true },
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", request);
  await expect(readPreflightTestFlight()).rejects.toThrow("group access differs");
  expect(request).toHaveBeenCalledTimes(1);
});

test("never follows App Store Connect pagination to another origin", async () => {
  stubCredentials();
  const request = vi.fn(async () =>
    Response.json({ data: [group], links: { next: "https://unexpected.test/betaGroups" } }),
  );
  vi.stubGlobal("fetch", request);
  await expect(readPreflightTestFlight()).rejects.toThrow("Invalid App Store Connect response URL");
  expect(request).toHaveBeenCalledTimes(1);
});
