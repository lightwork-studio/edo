import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { expect, test } from "vitest";

const revision = "a".repeat(40);
const runtime = "b".repeat(40);
const repositoryId = 12;
const workflowId = 31;
const name = `edo-preflight-native-${revision}`;
const buildId = "719fd3d0-36c3-4a54-8015-febf597839a8";
const otherBuildId = "91387b57-7c25-43c5-9e07-7c79a93ee177";
const row = {
  id: 1,
  name,
  expired: false,
  size_in_bytes: 230,
  workflow_run: {
    id: 101,
    repository_id: repositoryId,
    head_repository_id: repositoryId,
    head_branch: "main",
    head_sha: revision,
  },
};
const run = {
  id: 101,
  workflow_id: workflowId,
  repository: { id: repositoryId },
  head_repository: { id: repositoryId },
  head_branch: "main",
  head_sha: revision,
  event: "workflow_run",
};
const page = (number: number) => `actions/artifacts?name=${name}&per_page=100&page=${number}`;
const archive = (id: string) => ({
  files: ["native-archive.json"],
  content: JSON.stringify({ id, revision, runtime }),
});

function lookup(responses: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "edo-preflight-native-handoffs-test-"));
  const bin = join(root, "bin");
  const trace = join(root, "trace");
  const fixtures = join(root, "fixtures.json");
  try {
    mkdirSync(bin);
    writeFileSync(trace, "");
    writeFileSync(
      fixtures,
      JSON.stringify({
        "actions/workflows/preflight.yml": {
          id: workflowId,
          path: ".github/workflows/preflight.yml",
        },
        ...responses,
      }),
    );
    writeFileSync(
      join(bin, "gh"),
      String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const [api, hostFlag, host, methodFlag, method, endpoint, ...extra] = process.argv.slice(2);
const prefix = "repos/lightwork-studio/edo/";
if (api !== "api" || hostFlag !== "--hostname" || host !== "github.com" || methodFlag !== "--method" ||
    method !== "GET" || !endpoint?.startsWith(prefix) || extra.length) process.exit(2);
const path = endpoint.slice(prefix.length);
fs.appendFileSync(process.env.MOCK_TRACE, path + "\n");
const response = JSON.parse(fs.readFileSync(process.env.MOCK_FIXTURES, "utf8"))[path];
if (response === undefined) {
  console.error("raw mock service failure", process.env.GH_TOKEN);
  process.exit(3);
}
console.log(JSON.stringify(response));
`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(bin, "unzip"),
      String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.length !== 3) process.exit(2);
if (args[0] === "-Z" && args[1] === "-1") {
  const archive = JSON.parse(fs.readFileSync(args[2], "utf8"));
  console.log(archive.files.join("\n"));
} else if (args[0] === "-p" && args[2] === "native-archive.json") {
  const archive = JSON.parse(fs.readFileSync(args[1], "utf8"));
  process.stdout.write(archive.content);
} else {
  process.exit(2);
}
`,
      { mode: 0o700 },
    );
    const script = fileURLToPath(
      new URL("../scripts/load-preflight-native-handoffs.sh", import.meta.url),
    );
    const result = spawnSync("bash", [script], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: bin + delimiter + process.env.PATH,
        GH_TOKEN: "synthetic Actions credential",
        GITHUB_REPOSITORY: "lightwork-studio/edo",
        GITHUB_REPOSITORY_ID: String(repositoryId),
        TARGET: revision,
        RUNNER_TEMP: root,
        MOCK_TRACE: trace,
        MOCK_FIXTURES: fixtures,
      },
    });
    if (result.error) throw result.error;
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      trace: readFileSync(trace, "utf8").trim().split("\n"),
      remaining: readdirSync(root).sort(),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("loads all matching pages, verifies each workflow run, and deduplicates approved build IDs", () => {
  const firstPage = [
    row,
    { ...row, id: 2, workflow_run: { ...row.workflow_run, id: 102 } },
    { ...row, id: 3, workflow_run: { ...row.workflow_run, id: 103 } },
    { ...row, id: 4, workflow_run: { ...row.workflow_run, id: 104 } },
    { ...row, id: 5, workflow_run: { ...row.workflow_run, id: 105, head_repository_id: 92 } },
    { ...row, id: 6, workflow_run: { ...row.workflow_run, id: 106, repository_id: 92 } },
    { ...row, id: 7, workflow_run: { ...row.workflow_run, id: 107, head_branch: "other" } },
    { ...row, id: 8, workflow_run: { ...row.workflow_run, id: 108, head_sha: "e".repeat(40) } },
    { ...row, id: 9, workflow_run: { ...row.workflow_run, id: 109 } },
    ...Array.from({ length: 91 }, (_, index) => ({
      ...row,
      id: index + 10,
      expired: true,
    })),
  ];
  const result = lookup({
    [page(1)]: { total_count: 101, artifacts: firstPage },
    [page(2)]: {
      total_count: 101,
      artifacts: [{ ...row, id: 101, workflow_run: { ...row.workflow_run, id: 110 } }],
    },
    "actions/runs/101": run,
    "actions/runs/102": { ...run, id: 102, event: "workflow_dispatch" },
    "actions/runs/103": { ...run, id: 103, workflow_id: workflowId + 1 },
    "actions/runs/104": { ...run, id: 104, event: "pull_request" },
    "actions/runs/109": { ...run, id: 109, head_repository: { id: repositoryId + 1 } },
    "actions/runs/110": { ...run, id: 110 },
    "actions/artifacts/1/zip": archive(buildId),
    "actions/artifacts/2/zip": archive(buildId),
    "actions/artifacts/101/zip": archive(otherBuildId),
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([buildId, otherBuildId]);
  expect(result.trace.filter((path) => path.endsWith("/zip"))).toEqual([
    "actions/artifacts/1/zip",
    "actions/artifacts/2/zip",
    "actions/artifacts/101/zip",
  ]);
  expect(result.remaining).toEqual(["bin", "fixtures.json", "trace"]);
});

test.each([
  {
    fixture: { ...archive(buildId), files: ["nested/native-archive.json"] },
    diagnostic: "Invalid archive",
  },
  {
    fixture: { ...archive(buildId), files: ["native-archive.json", "native-archive.json"] },
    diagnostic: "Invalid archive",
  },
  {
    fixture: { ...archive(buildId), content: JSON.stringify("x".repeat(1025)) },
    diagnostic: "Invalid archive",
  },
  { fixture: archive(`${buildId}\n`), diagnostic: "Invalid payload" },
  {
    fixture: {
      ...archive(buildId),
      content: `{"id":"${otherBuildId}",${archive(buildId).content.slice(1)}`,
    },
    diagnostic: "Invalid payload",
  },
  {
    fixture: {
      ...archive(buildId),
      content: JSON.stringify({ id: buildId, revision: runtime, runtime }),
    },
    diagnostic: "Invalid payload",
  },
])(
  "returns no IDs when an approved archive or payload is invalid ($diagnostic)",
  ({ fixture, diagnostic }) => {
    const result = lookup({
      [page(1)]: { total_count: 2, artifacts: [row, { ...row, id: 2 }] },
      "actions/runs/101": run,
      "actions/artifacts/1/zip": archive(buildId),
      "actions/artifacts/2/zip": fixture,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(diagnostic);
  },
);

test("fails closed if pagination is incomplete or a run lookup fails", () => {
  const truncated = lookup({ [page(1)]: { total_count: 2, artifacts: [row] } });
  expect(truncated.status).toBe(1);
  expect(truncated.stderr).toContain("listing changed");
  expect(truncated.stdout).toBe("");

  const unverified = lookup({ [page(1)]: { total_count: 1, artifacts: [row] } });
  expect(unverified.status).toBe(1);
  expect(unverified.stdout).toBe("");
  expect(unverified.stderr).toBe(
    "Could not verify the run that created an Edo Preflight handoff.\n",
  );
});

test("reports an empty array when the revision has no handoffs", () => {
  const result = lookup({ [page(1)]: { total_count: 0, artifacts: [] } });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([]);
});
