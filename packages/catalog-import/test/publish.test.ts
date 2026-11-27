import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  type CatalogBuilder,
  type CatalogImportInput,
  clearPreparedCatalogSource,
  publishCatalog,
} from "../src/index.ts";
import { compatibleCatalog } from "../src/manifest.ts";

let directory: string;
let input: CatalogImportInput;

const builder: CatalogBuilder = {
  async build(source, artifact) {
    const name = await readFile(source, "utf8");
    using database = new DatabaseSync(artifact);
    database.exec("CREATE TABLE food (name TEXT NOT NULL); PRAGMA user_version = 1");
    database.prepare("INSERT INTO food VALUES (?)").run(name);
    return { accepted: 1, rejected: 2, skipped: 3 };
  },
  async validate(artifact, counts) {
    using database = new DatabaseSync(artifact, { readOnly: true });
    const row = database.prepare("SELECT COUNT(*) AS count FROM food").get();
    const integrity = database.prepare("PRAGMA integrity_check").get();
    if (row?.count !== counts.accepted || integrity?.integrity_check !== "ok") {
      throw new Error("Catalog did not pass integrity check");
    }
  },
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "edo-catalog-"));
  input = {
    root: join(directory, "published"),
    inputPath: join(directory, "source.txt"),
    provider: "bls",
    schemaVersion: 1,
    importerVersion: "1",
    source: { release: "fixture-1", url: "https://example.test/source" },
    attribution: { name: "Synthetic provider", license: "CC0-1.0", changes: "Indexed names" },
  };
  await writeFile(input.inputPath, "Sample food");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function active(): Promise<unknown> {
  return JSON.parse(await readFile(join(input.root, input.provider, "active.json"), "utf8"));
}

it("publishes a readable SQLite artifact and reproducible manifest without duplicating a release", async () => {
  const first = await publishCatalog(input, builder);
  const second = await publishCatalog(input, builder);
  const providerRoot = join(input.root, input.provider);
  const artifactName = `${first.artifact.sha256}.sqlite`;
  const artifactPath = join(providerRoot, "artifacts", artifactName);
  const bytes = await readFile(artifactPath);

  expect(second).toEqual(first);
  expect(await active()).toEqual(first);
  expect(first.source.sha256).toBe(createHash("sha256").update("Sample food").digest("hex"));
  expect(first.artifact).toEqual({
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
  expect(first.counts).toEqual({ accepted: 1, rejected: 2, skipped: 3 });
  expect(await readdir(join(providerRoot, "artifacts"))).toEqual([artifactName]);
  expect(await readdir(join(providerRoot, "releases"))).toHaveLength(1);
  using database = new DatabaseSync(artifactPath, { readOnly: true });
  expect(database.prepare("SELECT name FROM food").get()).toMatchObject({ name: "Sample food" });
});

it.each(["artifact", "manifest"] as const)(
  "rejects an immutable %s symlink with matching bytes",
  async (kind) => {
    const first = await publishCatalog(input, builder);
    const providerRoot = join(input.root, input.provider);
    const activePath = join(providerRoot, "active.json");
    const activeBytes = await readFile(activePath);
    const activeStat = await stat(activePath, { bigint: true });
    const manifestSha = createHash("sha256").update(activeBytes).digest("hex");
    const destination =
      kind === "artifact"
        ? join(providerRoot, "artifacts", `${first.artifact.sha256}.sqlite`)
        : join(providerRoot, "releases", `${manifestSha}.json`);
    const original = join(directory, "original");
    const bytes = await readFile(destination);
    await rename(destination, original);
    await symlink(original, destination, "file");

    await expect(publishCatalog(input, builder)).rejects.toThrow(
      "Stored catalog file does not match its checksum",
    );
    expect(await readFile(activePath)).toEqual(activeBytes);
    expect((await stat(activePath, { bigint: true })).mtimeNs).toBe(activeStat.mtimeNs);
    expect(await readlink(destination)).toBe(original);
    expect(await readFile(original)).toEqual(bytes);
  },
);

it("keeps the active release when a build is interrupted or validation fails", async () => {
  const first = await publishCatalog(input, builder);
  await writeFile(input.inputPath, "New food");
  const next = { ...input, source: { ...input.source, release: "fixture-2" } };
  const interrupted = join(input.root, input.provider, ".stage-abandoned");
  await mkdir(interrupted);
  await writeFile(join(interrupted, "active.json"), "incomplete");

  await expect(
    publishCatalog(next, {
      ...builder,
      async build(source, artifact) {
        await builder.build(source, artifact);
        throw new Error("Interrupted build");
      },
    }),
  ).rejects.toThrow("Interrupted build");
  await expect(
    publishCatalog(next, {
      ...builder,
      async validate() {
        throw new Error("Unexpected rows");
      },
    }),
  ).rejects.toThrow("Unexpected rows");
  await expect(
    publishCatalog(next, {
      ...builder,
      async validate(artifact, counts) {
        await builder.validate(artifact, counts);
        await writeFile(`${artifact}-wal`, "leftover journal");
      },
    }),
  ).rejects.toThrow("standalone SQLite file");

  expect(await active()).toEqual(first);
  expect(await readdir(join(input.root, input.provider, "artifacts"))).toHaveLength(1);
  const resumed = await publishCatalog(next, builder);
  expect(await active()).toEqual(resumed);
  expect(resumed.artifact.sha256).not.toBe(first.artifact.sha256);
});

it("lets an older consumer keep its last working catalog and skips other providers", async () => {
  const first = await publishCatalog(input, builder);
  await publishCatalog({ ...input, provider: "open-food-facts" }, builder);
  expect(await active()).toEqual(first);

  await writeFile(input.inputPath, "New food");
  await expect(publishCatalog({ ...input, schemaVersion: 2 }, builder)).rejects.toThrow(
    "SQLite schema does not match",
  );
  const next = await publishCatalog(
    { ...input, schemaVersion: 2 },
    {
      ...builder,
      async build(source, artifact) {
        const counts = await builder.build(source, artifact);
        using database = new DatabaseSync(artifact);
        database.exec("ALTER TABLE food RENAME COLUMN name TO name_de; PRAGMA user_version = 2");
        return counts;
      },
    },
  );
  expect(compatibleCatalog(await active(), input.provider, [2])).toEqual(next);
  expect(compatibleCatalog(await active(), input.provider, [1])).toBeNull();
  expect(compatibleCatalog(first, "open-food-facts", [1])).toBeNull();
  const previous = join(input.root, input.provider, "artifacts", `${first.artifact.sha256}.sqlite`);
  using database = new DatabaseSync(previous, { readOnly: true });
  expect(database.prepare("SELECT name FROM food").get()).toMatchObject({ name: "Sample food" });
});

it("rejects a closed WAL database and leaves the previous release readable", async () => {
  const first = await publishCatalog(input, builder);
  await expect(
    publishCatalog(input, {
      ...builder,
      async build(source, artifact) {
        const counts = await builder.build(source, artifact);
        using database = new DatabaseSync(artifact);
        database.exec("PRAGMA journal_mode = WAL");
        return counts;
      },
      async validate() {},
    }),
  ).rejects.toThrow("DELETE journal mode");
  expect(await active()).toEqual(first);
});

it("refuses to publish provenance for source bytes that changed during the build", async () => {
  const first = await publishCatalog(input, builder);
  await expect(
    publishCatalog(input, {
      ...builder,
      async build(source, artifact) {
        await writeFile(source, "Replaced source");
        return builder.build(source, artifact);
      },
    }),
  ).rejects.toThrow("Catalog input changed during import");
  expect(await active()).toEqual(first);
});

it("rejects overlapping publishers for one provider while allowing another provider", async () => {
  const manifest = await publishCatalog(input, {
    ...builder,
    async build(source, artifact) {
      await expect(publishCatalog(input, builder)).rejects.toThrow(/locked/);
      const other = await publishCatalog({ ...input, provider: "open-food-facts" }, builder);
      expect(other.provider).toBe("open-food-facts");
      return builder.build(source, artifact);
    },
  });
  expect(await active()).toEqual(manifest);
  expect(await publishCatalog(input, builder)).toEqual(manifest);
});

it("builds from the same staged bytes even if the download path is replaced", async () => {
  const manifest = await publishCatalog(input, {
    ...builder,
    async build(snapshot, artifact) {
      await rename(input.inputPath, `${input.inputPath}.previous`);
      await writeFile(input.inputPath, "Another release");
      return builder.build(snapshot, artifact);
    },
  });
  expect(manifest.source.sha256).toBe(createHash("sha256").update("Sample food").digest("hex"));
  const artifact = join(
    input.root,
    input.provider,
    "artifacts",
    `${manifest.artifact.sha256}.sqlite`,
  );
  using database = new DatabaseSync(artifact, { readOnly: true });
  expect(database.prepare("SELECT name FROM food").get()).toMatchObject({ name: "Sample food" });
});

it("builds directly from its managed download and keeps that file while the publisher owns it", async () => {
  const first = await publishCatalog(input, builder);
  const { inputPath, ...metadata } = input;
  let managedSource = "";

  const second = await publishCatalog(
    {
      ...metadata,
      async prepareInput(destination) {
        managedSource = destination;
        expect(destination).not.toBe(inputPath);
        await writeFile(destination, "Sample food", { flag: "wx" });
        await expect(clearPreparedCatalogSource(input.root, input.provider)).rejects.toThrow(
          /locked/,
        );
      },
    },
    {
      ...builder,
      async build(source, artifact) {
        expect(source).toBe(managedSource);
        return builder.build(source, artifact);
      },
    },
  );

  expect(second).toEqual(first);
  expect(await active()).toEqual(first);
  await expect(readFile(managedSource)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects an externally linked or changed managed source without affecting the prior release", async () => {
  const first = await publishCatalog(input, builder);
  const { inputPath, ...metadata } = input;

  await expect(
    publishCatalog(
      {
        ...metadata,
        async prepareInput(destination) {
          await link(inputPath, destination);
        },
      },
      builder,
    ),
  ).rejects.toThrow("Catalog source must be a regular file with a single link");
  await expect(
    publishCatalog(
      {
        ...metadata,
        async prepareInput(destination) {
          await writeFile(destination, "Sample food", { flag: "wx" });
        },
      },
      {
        ...builder,
        async build(source, artifact) {
          await writeFile(source, "Replaced managed source");
          return builder.build(source, artifact);
        },
      },
    ),
  ).rejects.toThrow("Catalog input changed during import");

  expect(await active()).toEqual(first);
  expect(await readFile(inputPath, "utf8")).toBe("Sample food");
});
