import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const config = resolve(__dirname, "../../prek.toml");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const hasPrek = spawnSync("prek", ["--version"]).status === 0;

describe.skipIf(!hasPrek)("configured bundle refresh hook", () => {
  it("refreshes a lockfile update, converges, and propagates build failure", () => {
    const directory = mkdtempSync(join(tmpdir(), "bundle-hook-"));
    directories.push(directory);
    // Keep the configured local hooks, without fetching unrelated remote hooks.
    const localConfig = join(directory, "prek.toml");
    writeFileSync(
      localConfig,
      readFileSync(config, "utf8")
        .split(/(?=^\[\[repos\]\]$)/m)
        .filter((repository) => /^repo = "local"$/m.test(repository))
        .join(""),
    );
    const run = (
      command: string,
      args: string[],
    ): ReturnType<typeof spawnSync> =>
      spawnSync(command, args, {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, PREK_HOME: join(directory, "prek-cache") },
      });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { build: "node build.cjs" } }),
    );
    writeFileSync(join(directory, "package-lock.json"), '{"version":1}\n');
    writeFileSync(
      join(directory, "build.cjs"),
      'require("node:fs").writeFileSync("bundle.js", String(require("./package-lock.json").version));\n',
    );
    writeFileSync(join(directory, "bundle.js"), "1");
    expect(run("git", ["init"]).status).toBe(0);
    expect(run("git", ["add", "."]).status).toBe(0);
    writeFileSync(join(directory, "package-lock.json"), '{"version":2}\n');
    expect(run("git", ["add", "package-lock.json"]).status).toBe(0);

    const hook = (): ReturnType<typeof spawnSync> =>
      run("prek", [
        "run",
        "--config",
        localConfig,
        "build-dist",
        "--files",
        "package-lock.json",
      ]);
    const first = hook();
    expect(first.status, first.output?.join("\n")).toBe(1); // prek reports files modified by the build.
    expect(readFileSync(join(directory, "bundle.js"), "utf8")).toBe("2");
    expect(hook().status).toBe(0);

    writeFileSync(join(directory, "build.cjs"), "process.exit(2);\n");
    expect(hook().status).not.toBe(0);
  }, 30000);
});
