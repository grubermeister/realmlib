import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import packageJson from "../package.json";

const repoRoot = await realpath(join(import.meta.dir, ".."));
const childTimeoutMs = 10_000;

test(
  "an independent Bun consumer can import the package by name",
  async () => {
    const packageName = packageJson.name;
    const marker = `realmlib-import-ok:${randomUUID()}`;

    const consumerDir = await realpath(await mkdtemp(join(tmpdir(), "realmlib-consumer-")));
    const fromRepo = relative(repoRoot, consumerDir);
    expect(fromRepo.startsWith("..") || isAbsolute(fromRepo)).toBe(true);

    const linkPath = join(consumerDir, "node_modules", packageName);
    let child: ReturnType<typeof Bun.spawn> | undefined;

    try {
      await writeFile(
        join(consumerDir, "package.json"),
        JSON.stringify({ name: "realmlib-consumer", private: true, type: "module" }),
      );
      await writeFile(
        join(consumerDir, "probe.js"),
        `import { entityId, moduleId, workItemId, simTime } from ${JSON.stringify(packageName)};\n` +
          `const values = [entityId("e"), moduleId("m"), workItemId("w"), simTime(0)];\n` +
          `console.log(${JSON.stringify(marker)}, JSON.stringify(values));\n`,
      );
      await mkdir(join(consumerDir, "node_modules"));
      await symlink(repoRoot, linkPath, "dir");

      const env: Record<string, string> = {};
      if (process.env.PATH) env.PATH = process.env.PATH;

      child = Bun.spawn([process.execPath, "--no-env-file", "probe.js"], {
        cwd: consumerDir,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: childTimeoutMs,
        killSignal: "SIGKILL",
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout as ReadableStream).text(),
        new Response(child.stderr as ReadableStream).text(),
        child.exited,
      ]);

      expect(stderr).toBe("");
      expect(stdout).toBe(`${marker} ["e","m","w",0]\n`);
      expect(exitCode).toBe(0);
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      // Remove the link itself first so cleanup can never reach the repository it points to.
      await unlink(linkPath).catch(() => {});
      await rm(consumerDir, { recursive: true, force: true });
    }
  },
  childTimeoutMs + 5_000,
);
