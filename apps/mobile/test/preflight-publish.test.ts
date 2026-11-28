import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { URL } from "node:url";
import { expect, test } from "vitest";

const sha = "a".repeat(40);
const runtime = "b".repeat(40);
const committedConfig = readFileSync(new URL("../eas.json", import.meta.url), "utf8");
const compatibleBuild = {
  appIdentifier: "studio.lightwork.edo",
  updateChannel: { id: "test-channel", name: "preflight" },
  runtime: { id: "test-runtime", version: runtime },
  distribution: "STORE",
  status: "FINISHED",
};

type Options = {
  builds?: readonly unknown[];
  force?: boolean;
  noAppleKey?: boolean;
  stale?: boolean;
  superseded?: boolean;
  supersededAfterExport?: boolean;
  noRemote?: boolean;
  dirty?: boolean;
  runtime?: string;
  previewEnv?: Record<string, string>;
};

function exercise(options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "edo-preflight-test-"));
  const mobile = join(root, "mobile");
  const bin = join(root, "bin");
  const log = join(root, "commands.log");
  const key = join(root, "synthetic.p8");
  const config = join(mobile, "eas.json");

  try {
    mkdirSync(join(mobile, "scripts"), { recursive: true });
    mkdirSync(bin);
    writeFileSync(log, "");
    writeFileSync(key, "synthetic key");
    writeFileSync(config, committedConfig);
    const script = join(mobile, "scripts", "publish-preflight.sh");
    copyFileSync(new URL("../scripts/publish-preflight.sh", import.meta.url), script);
    copyFileSync(
      new URL("../scripts/check-preflight-env.cjs", import.meta.url),
      join(mobile, "scripts", "check-preflight-env.cjs"),
    );
    writeFileSync(
      join(bin, "git"),
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "switch (process.argv[2]) {",
        '  case "rev-parse": console.log(process.env.TARGET); break;',
        '  case "status": if (process.env.TEST_DIRTY) console.log(" M dirty.js"); break;',
        '  case "ls-remote": {',
        "    if (process.env.TEST_NO_REMOTE) process.exit(128);",
        "    const moved = process.env.TEST_STALE ||",
        "      (process.env.TEST_SUPERSEDED && fs.existsSync(process.env.TEST_TIP_CHECK)) ||",
        "      (process.env.TEST_SUPERSEDED_AFTER_EXPORT && process.env.EDO_OTA_OUTPUT);",
        '    fs.writeFileSync(process.env.TEST_TIP_CHECK, "seen");',
        '    console.log((moved ? "c".repeat(40) : process.env.TARGET) + "\\trefs/heads/main"); break;',
        "  }",
        "  default: process.exit(3);",
        "}",
      ].join("\n"),
      { mode: 0o700 },
    );
    writeFileSync(
      join(bin, "pnpm"),
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const { spawnSync } = require("node:child_process");',
        "const outcome = process.argv.slice(2);",
        'if (outcome.shift() !== "exec" || outcome.shift() !== "eas") process.exit(4);',
        'if (process.env.EDO_APP_VARIANT !== "preflight" || process.env.EXPO_NO_DOTENV !== "1" ||',
        '    process.env.EXPO_PUBLIC_EDO_CATALOG_ORIGIN !== "https://edo.timweb.app") process.exit(5);',
        'fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(outcome) + "\\n");',
        "switch (outcome[0]) {",
        '  case "env:exec": {',
        '    if (outcome[1] !== "preview" || !outcome[2].startsWith("node scripts/check-preflight-env.cjs && ")) process.exit(8);',
        '    const checked = spawnSync(process.execPath, ["scripts/check-preflight-env.cjs"], {',
        '      env: { ...process.env, ...JSON.parse(process.env.TEST_PREVIEW_ENV) }, stdio: "inherit",',
        "    });",
        "    if (checked.status !== 0) process.exit(checked.status || 1);",
        '    if (outcome[2].includes("expo-updates runtimeversion:resolve")) {',
        "      console.log(JSON.stringify({runtimeVersion: process.env.TEST_RUNTIME}));",
        '    } else if (outcome[2].includes("expo export --platform ios") && process.env.EDO_OTA_OUTPUT) {',
        '      fs.writeFileSync(process.env.EDO_OTA_OUTPUT + "/metadata.json", "{}");',
        "    } else process.exit(9);",
        "    break;",
        "  }",
        '  case "build:list": console.log(process.env.TEST_BUILDS); break;',
        '  case "update": {',
        '    const dir = outcome[outcome.indexOf("--input-dir") + 1];',
        '    if (!outcome.includes("--skip-bundler") || !fs.existsSync(dir + "/metadata.json")) process.exit(10);',
        "    break;",
        "  }",
        '  case "build": {',
        '    const submit = JSON.parse(fs.readFileSync("eas.json", "utf8")).submit.preflight.ios;',
        '    if (submit.ascAppId !== "6840244969" || submit.groups[0] !== "Archive Restore" ||',
        '        submit.ascApiKeyPath !== "$ASC_API_KEY_PATH" ||',
        '        process.env.ASC_API_KEY_PATH.startsWith(process.cwd() + "/") ||',
        "        !fs.existsSync(process.env.ASC_API_KEY_PATH)) process.exit(6);",
        "    break;",
        "  }",
        "  default: process.exit(7);",
        "}",
      ].join("\n"),
      { mode: 0o700 },
    );

    const result = spawnSync("bash", [script], {
      cwd: mobile,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: bin + delimiter + process.env.PATH,
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "lightwork-studio/edo",
        GITHUB_STEP_SUMMARY: join(root, "summary"),
        RUNNER_TEMP: root,
        TARGET: sha,
        EXPO_TOKEN: "synthetic Expo credential",
        FORCE_BUILD: options.force ? "true" : "false",
        ASC_API_KEY_PATH: options.noAppleKey ? "" : key,
        ASC_API_KEY_ID: "synthetic-key",
        ASC_API_ISSUER_ID: "synthetic-issuer",
        TEST_BUILDS: JSON.stringify(options.builds ?? []),
        TEST_RUNTIME: options.runtime ?? runtime,
        TEST_STALE: options.stale ? "yes" : "",
        TEST_NO_REMOTE: options.noRemote ? "yes" : "",
        TEST_SUPERSEDED: options.superseded ? "yes" : "",
        TEST_SUPERSEDED_AFTER_EXPORT: options.supersededAfterExport ? "yes" : "",
        TEST_DIRTY: options.dirty ? "yes" : "",
        TEST_LOG: log,
        TEST_TIP_CHECK: join(root, "tip-checked"),
        TEST_PREVIEW_ENV: JSON.stringify(options.previewEnv ?? {}),
      },
    });
    const commands: string[][] = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(readFileSync(config, "utf8")).toBe(committedConfig);
    return { commands, status: result.status, diagnostic: result.stdout + result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("publishes OTA to iOS for a compatible preflight binary, even without Apple credentials", () => {
  const result = exercise({ builds: [compatibleBuild], noAppleKey: true });
  expect(result.status).toBe(0);
  expect(result.commands.map(([command]) => command)).toEqual([
    "env:exec",
    "build:list",
    "env:exec",
    "update",
  ]);
  expect(result.commands[1]).toEqual(
    expect.arrayContaining(["--runtime-version", runtime, "--channel", "preflight"]),
  );
  expect(result.commands[3]).toEqual([
    "update",
    "--channel",
    "preflight",
    "--platform",
    "ios",
    "--environment",
    "preview",
    "--skip-bundler",
    "--input-dir",
    expect.stringContaining("/edo-ota."),
    "--message",
    "Edo Preflight aaaaaaaaaaaa",
    "--non-interactive",
  ]);
});

test("uses a compatible queued build and ignores wrong runtimes, channels, bundles and errors", () => {
  const invalid = [
    { ...compatibleBuild, runtime: { version: "e".repeat(40) } },
    { ...compatibleBuild, updateChannel: { name: "production" } },
    { ...compatibleBuild, updateChannel: null },
    { ...compatibleBuild, appIdentifier: "another.bundle" },
    { ...compatibleBuild, status: "ERRORED" },
    { ...compatibleBuild, distribution: "INTERNAL" },
  ];
  expect(exercise({ builds: invalid }).commands.at(-1)?.[0]).toBe("build");
  expect(
    exercise({ builds: [...invalid, { ...compatibleBuild, status: "IN_QUEUE" }] }).commands.at(
      -1,
    )?.[0],
  ).toBe("update");
});

test("queues a native build and the internal submission or forces one when requested", () => {
  for (const result of [exercise(), exercise({ builds: [compatibleBuild], force: true })]) {
    expect(result.status).toBe(0);
    expect(result.commands.at(-1)).toEqual([
      "build",
      "--platform",
      "ios",
      "--profile",
      "preflight",
      "--auto-submit-with-profile",
      "preflight",
      "--non-interactive",
      "--freeze-credentials",
      "--no-wait",
      "--message",
      "Edo Preflight aaaaaaaaaaaa",
    ]);
  }
});

test("checks the revision again before publishing and fails if it cannot verify main", () => {
  expect(exercise({ stale: true }).commands).toEqual([]);
  const superseded = exercise({ builds: [compatibleBuild], superseded: true });
  expect(superseded.status).toBe(0);
  expect(superseded.commands.map(([command]) => command)).toEqual(["env:exec", "build:list"]);
  const afterExport = exercise({ builds: [compatibleBuild], supersededAfterExport: true });
  expect(afterExport.status).toBe(0);
  expect(afterExport.commands.map(([command]) => command)).toEqual([
    "env:exec",
    "build:list",
    "env:exec",
  ]);
  const unavailable = exercise({ noRemote: true });
  expect(unavailable.status).not.toBe(0);
  expect(unavailable.commands).toEqual([]);
});

test("fails closed when the Expo preview environment disagrees with the committed build profile", () => {
  for (const [name, value] of [
    ["EDO_APP_VARIANT", "development"],
    ["EXPO_PUBLIC_EDO_CATALOG_ORIGIN", "https://unrelated.test"],
    ["EXPO_PUBLIC_EDO_BLS_PREVIEW_ORIGIN", "https://unrelated.test"],
  ]) {
    const result = exercise({ previewEnv: { [name]: value } });
    expect(result.status).not.toBe(0);
    expect(result.diagnostic).toContain(name);
    expect(result.diagnostic).not.toContain(value);
    expect(result.commands.map(([command]) => command)).toEqual(["env:exec"]);
  }
});

test("stops on dirty source, bad fingerprint or missing Apple credentials for a native build", () => {
  const dirty = exercise({ dirty: true });
  expect(dirty.status).not.toBe(0);
  expect(dirty.commands).toEqual([]);
  const invalid = exercise({ runtime: "malformed" });
  expect(invalid.status).not.toBe(0);
  expect(invalid.commands.map(([command]) => command)).toEqual(["env:exec"]);
  const missing = exercise({ noAppleKey: true });
  expect(missing.status).not.toBe(0);
  expect(missing.diagnostic).toContain("A native build needs the App Store Connect key");
  expect(missing.commands.map(([command]) => command)).toEqual(["env:exec", "build:list"]);
});
