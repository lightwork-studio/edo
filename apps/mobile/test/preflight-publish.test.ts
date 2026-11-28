import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { URL } from "node:url";
import { expect, test, vi } from "vitest";
import { appStoreApp, preflightGroup, preflightGroupId } from "../scripts/preflight-delivery.mts";

vi.setConfig({ testTimeout: 30_000 });

const revision = "a".repeat(40);
const runtime = "b".repeat(40);
const buildId = "719fd3d0-36c3-4a54-8015-febf597839a8";
const expoProject = "fd9dba15-d0b8-4594-a2b0-aed4cc0a0b7a";
const signedBuild = {
  id: buildId,
  app: { id: expoProject },
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
  app: { id: expoProject },
  iosConfig: { ascAppIdentifier: appStoreApp },
  platform: "IOS",
  status: "FINISHED",
  submittedBuild: { id: buildId },
};
const receipt = {
  id: "86848d23-8f82-437a-8bb3-43a06c083d91",
  marketingVersion: "0.1.0",
  buildNumber: "3",
  platform: "IOS",
  processingState: "VALID",
  internalBuildState: "IN_BETA_TESTING",
  expired: false,
  expirationDate: new Date(Date.now() + 86_400_000).toISOString(),
};
const channel = {
  name: "preflight",
  isPaused: false,
  updateBranches: [{ id: "private-branch", name: "preflight" }],
  branchMapping: JSON.stringify({
    version: 0,
    data: [{ branchId: "private-branch", branchMappingLogic: "true" }],
  }),
};

function run(
  stage: "expo" | "submit",
  options: { delivered?: boolean; shared?: boolean; stale?: boolean; preview?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "edo-preflight-release-test-"));
  const mobile = join(root, "mobile");
  const bin = join(root, "bin");
  const trace = join(root, "trace");
  const state = join(root, "submitted");
  const output = join(root, "output");
  const observedAt = Date.now();
  const fixture = {
    appStoreAppId: appStoreApp,
    group: preflightGroup,
    groupId: preflightGroupId,
    isInternalGroup: true,
    observedAt,
  };
  const unavailable = { ...fixture, memberBuildIds: [], knownBuilds: [], builds: [] };
  const available = {
    ...fixture,
    memberBuildIds: [receipt.id],
    knownBuilds: [receipt],
    builds: [receipt],
  };
  try {
    mkdirSync(join(mobile, "scripts"), { recursive: true });
    mkdirSync(bin);
    writeFileSync(trace, "");
    writeFileSync(output, "");
    copyFileSync(new URL("../eas.json", import.meta.url), join(mobile, "eas.json"));
    for (const name of [
      "publish-preflight.sh",
      "preflight-plan.mts",
      "preflight-delivery.mts",
      "check-preflight-env.cjs",
    ]) {
      copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(mobile, "scripts", name));
    }
    writeFileSync(
      join(mobile, "scripts", "preflight-apple.mts"),
      [
        'import { existsSync } from "node:fs";',
        "console.log(existsSync(process.env.MOCK_STATE) ? process.env.MOCK_AVAILABLE : process.env.MOCK_UNAVAILABLE);",
      ].join("\n"),
    );
    writeFileSync(
      join(bin, "git"),
      [
        "#!/usr/bin/env node",
        'const { existsSync } = require("node:fs");',
        'if (process.argv[2] === "rev-parse") console.log(process.env.TARGET);',
        'if (process.argv[2] === "ls-remote") {',
        '  const moved = process.env.MOCK_STALE === "yes" && existsSync(process.env.MOCK_EXPORT);',
        '  console.log((moved ? "d".repeat(40) : process.env.TARGET) + "\\trefs/heads/main");',
        "}",
      ].join("\n"),
      { mode: 0o700 },
    );
    writeFileSync(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
    writeFileSync(
      join(bin, "pnpm"),
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "const args = process.argv.slice(2);",
        'if (args.shift() !== "exec") process.exit(4);',
        "const cli = args.shift();",
        'if (cli === "expo-updates") {',
        "  if (process.env.ASC_API_KEY_P8 || process.env.EXPO_TOKEN) process.exit(11);",
        "  console.log(JSON.stringify({runtimeVersion: process.env.MOCK_RUNTIME})); process.exit(0);",
        "}",
        'if (cli === "expo") {',
        '  if (process.env.ASC_API_KEY_P8 || process.env.EXPO_TOKEN || args[0] !== "export") process.exit(12);',
        '  fs.mkdirSync(args[args.indexOf("--output-dir") + 1]); fs.writeFileSync(process.env.MOCK_EXPORT, "ready"); process.exit(0);',
        "}",
        'if (cli !== "eas") process.exit(4);',
        "const command = args[0];",
        'fs.appendFileSync(process.env.MOCK_TRACE, JSON.stringify(args) + "\\n");',
        'if (process.env.MOCK_STAGE === "expo" && process.env.ASC_API_KEY_P8) process.exit(5);',
        "switch (command) {",
        '  case "env:pull":',
        '    if (process.env.MOCK_STAGE !== "expo") process.exit(6);',
        '    fs.writeFileSync(args[args.indexOf("--path") + 1], process.env.MOCK_PREVIEW);',
        "    break;",
        '  case "build:list": console.log(process.env.MOCK_DELIVERED === "yes" ? "[" + process.env.MOCK_BUILD + "]" : "[]"); break;',
        '  case "build:view": console.log(process.env.MOCK_BUILD); break;',
        '  case "build":',
        '    if (args.some(arg => arg.startsWith("--auto-submit"))) process.exit(7);',
        '    console.log("[" + process.env.MOCK_BUILD + "]"); break;',
        '  case "channel:list": console.log(process.env.MOCK_CHANNELS); break;',
        '  case "submit:list":',
        '    console.log(process.env.MOCK_DELIVERED === "yes" || fs.existsSync(process.env.MOCK_STATE) ? "[" + process.env.MOCK_SUBMISSION + "]" : "[]"); break;',
        '  case "submit": {',
        "    const key = process.env.ASC_API_KEY_PATH;",
        '    if (process.env.MOCK_STAGE !== "submit" || !key || key.startsWith(process.cwd() + "/") ||',
        '      !fs.readFileSync(key,"utf8").includes("synthetic") || !args.includes("--no-auto-testflight-setup")) process.exit(8);',
        "    fs.writeFileSync(process.env.MOCK_STATE, key); break;",
        "  }",
        '  case "update": if (!args.includes("--skip-bundler") || !fs.existsSync(process.env.MOCK_EXPORT)) process.exit(9); break;',
        "  default: process.exit(10);",
        "}",
      ].join("\n"),
      { mode: 0o700 },
    );
    const result = spawnSync("bash", ["scripts/publish-preflight.sh", stage], {
      cwd: mobile,
      encoding: "utf8",
      timeout: 25_000,
      env: {
        ...process.env,
        PATH: bin + delimiter + process.env.PATH,
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "lightwork-studio/edo",
        GITHUB_RUN_ID: "11",
        GITHUB_STEP_SUMMARY: join(root, "summary"),
        GITHUB_OUTPUT: output,
        RUNNER_TEMP: root,
        TARGET: revision,
        FORCE_BUILD: "false",
        EXPO_TOKEN: "synthetic Expo value",
        ASC_API_KEY_P8: stage === "submit" ? "synthetic Apple value" : "",
        TESTFLIGHT_EVIDENCE: JSON.stringify(options.delivered ? available : unavailable),
        PREFLIGHT_BUILD: JSON.stringify({ id: buildId, runtime }),
        MOCK_STAGE: stage,
        MOCK_RUNTIME: runtime,
        MOCK_BUILD: JSON.stringify(signedBuild),
        MOCK_SUBMISSION: JSON.stringify(submission),
        MOCK_CHANNELS: JSON.stringify({
          currentPage: options.shared ? [channel, { ...channel, name: "public" }] : [channel],
        }),
        MOCK_TRACE: trace,
        MOCK_STATE: state,
        MOCK_EXPORT: join(root, "export-finished"),
        MOCK_STALE: options.stale ? "yes" : "",
        MOCK_PREVIEW: options.preview ?? "# No overriding variables",
        MOCK_DELIVERED: options.delivered ? "yes" : "",
        MOCK_AVAILABLE: JSON.stringify(available),
        MOCK_UNAVAILABLE: JSON.stringify(unavailable),
      },
    });
    if (result.error) throw result.error;
    const commands = readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((entry) => JSON.parse(entry) as string[]);
    return {
      status: result.status,
      diagnostic: result.stderr,
      commands,
      output: readFileSync(output, "utf8"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("publishes a compatible iOS update in the Expo stage and revalidates main after export", () => {
  const shipped = run("expo", { delivered: true });
  expect(shipped.status, shipped.diagnostic).toBe(0);
  expect(shipped.commands.at(-1)).toContain("update");
  const superseded = run("expo", { delivered: true, stale: true });
  expect(superseded.status, superseded.diagnostic).toBe(0);
  expect(superseded.commands.some(([command]) => command === "update")).toBe(false);
});

test("refuses to publish to an Expo branch shared by another channel", () => {
  const result = run("expo", { delivered: true, shared: true });
  expect(result.status).not.toBe(0);
  expect(result.commands.some(([command]) => command === "update")).toBe(false);
});

test("rejects unexpected Expo preview variables without loading their values", () => {
  const result = run("expo", {
    delivered: true,
    preview: "NODE_OPTIONS=--require=./must-not-load.js",
  });
  expect(result.status).not.toBe(0);
  expect(result.diagnostic).toContain("NODE_OPTIONS");
  expect(result.diagnostic).not.toContain("must-not-load.js");
  expect(result.commands.map(([command]) => command)).toEqual(["env:pull"]);
});

test("queues the native archive without Apple credentials and submits its exact ID in a fresh stage", () => {
  const prepared = run("expo");
  expect(prepared.status, prepared.diagnostic).toBe(0);
  expect(prepared.output).toContain("action=submit");
  expect(prepared.output).toContain(buildId);
  expect(prepared.commands.some(([command]) => command === "submit")).toBe(false);
  const submitted = run("submit");
  expect(submitted.status, submitted.diagnostic).toBe(0);
  expect(submitted.commands.filter(([command]) => command === "submit")).toEqual([
    expect.arrayContaining(["--id", buildId, "--wait"]),
  ]);
  expect(submitted.commands.some(([command]) => command === "env:pull")).toBe(false);
});
