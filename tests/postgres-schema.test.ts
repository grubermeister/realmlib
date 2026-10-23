import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";

// Opt-in: runs only against a separate, disposable database named by this variable.
const databaseUrl = process.env.REALMLIB_TEST_DATABASE_URL;
const repoRoot = await realpath(join(import.meta.dir, ".."));
const childTimeoutMs = 30_000;

test.skipIf(!databaseUrl)(
  "the PostgreSQL migration applies and enforces its schema, then rolls back (REALMLIB_TEST_DATABASE_URL)",
  async () => {
    const marker = `realmlib-schema-ok:${randomUUID()}`;
    // Paths are relative to the repository, the child's working directory.
    const script = [
      String.raw`DO $$ BEGIN IF EXISTS (SELECT FROM pg_namespace WHERE nspname = 'realmlib') THEN RAISE EXCEPTION 'refusing to run: schema realmlib already exists; use a separate disposable database'; END IF; END $$;`,
      "BEGIN;",
      String.raw`\i migrations/001_initial_persistence.sql`,
      String.raw`\i tests/postgres-schema.sql`,
      "ROLLBACK;",
      String.raw`DO $$ BEGIN IF EXISTS (SELECT FROM pg_namespace WHERE nspname = 'realmlib') THEN RAISE EXCEPTION 'schema realmlib remains after ROLLBACK'; END IF; END $$;`,
      String.raw`\echo ${marker}`,
      "",
    ].join("\n");

    // Only the explicit URL selects the database: no other PG* variables are passed on.
    const env: Record<string, string> = {};
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.HOME) env.HOME = process.env.HOME;

    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      try {
        child = Bun.spawn(
          ["psql", "--no-psqlrc", "--no-password", "--quiet", "--set", "ON_ERROR_STOP=1", "--dbname", databaseUrl!, "--file", "-"],
          {
            cwd: repoRoot,
            env,
            stdin: new Blob([script]),
            stdout: "pipe",
            stderr: "pipe",
            timeout: childTimeoutMs,
            killSignal: "SIGKILL",
          },
        );
      } catch (error) {
        throw new Error(`REALMLIB_TEST_DATABASE_URL is set but psql could not be started: ${error}`);
      }

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout as ReadableStream).text(),
        new Response(child.stderr as ReadableStream).text(),
        child.exited,
      ]);

      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(stdout).toBe(`${marker}\n`);
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
    }
  },
  childTimeoutMs + 5_000,
);
