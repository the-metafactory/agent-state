/**
 * scaffold.ts tests — covers the programmatic ScaffoldFolders workflow.
 *
 * Spawn-based tests exercise the real CLI surface that hosts call. A direct
 * import test pins the in-process API for callers who want to embed scaffold
 * (e.g. forge's TS-side install flow if/when it skips the shell wrapper).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

import { scaffold } from "../skill/scripts/scaffold";

const SCAFFOLD = resolve(import.meta.dirname, "..", "skill", "scripts", "scaffold.ts");

type RunResult = { exitCode: number; stdout: string; stderr: string };

async function run(args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", SCAFFOLD, ...args], {
    env: { ...process.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

describe("scaffold.ts — fresh instance", () => {
  let dir: string;
  let instance: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "as-scaffold-"));
    instance = join(dir, "instance");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates all six artifacts on a fresh dir and prints a 'created' line for each", async () => {
    const r = await run([instance, "--host=grove", "--agent=forge"]);
    expect(r.exitCode).toBe(0);

    // Files
    expect(existsSync(join(instance, "state.sqlite"))).toBe(true);
    expect(existsSync(join(instance, "dashboard.md"))).toBe(true);
    expect(existsSync(join(instance, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(instance, "context", "repos.md"))).toBe(true);
    expect(existsSync(join(instance, "context", "channels.md"))).toBe(true);
    expect(statSync(join(instance, "retros")).isDirectory()).toBe(true);

    // Stdout reports each creation.
    expect(r.stdout).toContain("scaffold: created state.sqlite");
    expect(r.stdout).toContain("scaffold: created dashboard.md");
    expect(r.stdout).toContain("scaffold: created CLAUDE.md");
    expect(r.stdout).toContain("scaffold: created context/");
    expect(r.stdout).toContain("scaffold: created context/repos.md");
    expect(r.stdout).toContain("scaffold: created context/channels.md");
    expect(r.stdout).toContain("scaffold: created retros/");
  });

  test("state.sqlite has work_items + events + schema_migrations tables (migration 0001 applied)", async () => {
    const r = await run([instance, "--host=grove", "--agent=forge"]);
    expect(r.exitCode).toBe(0);

    const db = new Database(join(instance, "state.sqlite"));
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toContain("work_items");
    expect(tables).toContain("events");
    expect(tables).toContain("schema_migrations");

    const versions = db
      .query<{ version: string }, []>("SELECT version FROM schema_migrations")
      .all()
      .map((r) => r.version);
    expect(versions).toContain("0001");
    db.close();
  });

  test("CLAUDE.md bridge file embeds the --host and --agent values", async () => {
    const r = await run([instance, "--host=grove", "--agent=forge"]);
    expect(r.exitCode).toBe(0);
    const claudeMd = readFileSync(join(instance, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("Host:** `grove`");
    expect(claudeMd).toContain("Agent:** `forge`");
  });
});

describe("scaffold.ts — idempotency", () => {
  let dir: string;
  let instance: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "as-scaffold-"));
    instance = join(dir, "instance");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("re-running on a fully-scaffolded dir is a clean no-op (all skipped)", async () => {
    const first = await run([instance, "--host=grove", "--agent=forge"]);
    expect(first.exitCode).toBe(0);

    const second = await run([instance, "--host=grove", "--agent=forge"]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("scaffold: skipped state.sqlite (exists)");
    expect(second.stdout).toContain("scaffold: skipped dashboard.md (exists)");
    expect(second.stdout).toContain("scaffold: skipped CLAUDE.md (exists)");
    expect(second.stdout).toContain("scaffold: skipped context/ (exists)");
    expect(second.stdout).toContain("scaffold: skipped context/repos.md (exists)");
    expect(second.stdout).toContain("scaffold: skipped context/channels.md (exists)");
    expect(second.stdout).toContain("scaffold: skipped retros/ (exists)");
    expect(second.stdout).not.toContain("scaffold: created");
  });

  test("operator-edited files are preserved across re-runs", async () => {
    const first = await run([instance, "--host=grove", "--agent=forge"]);
    expect(first.exitCode).toBe(0);

    // Operator hand-edits dashboard.md and CLAUDE.md.
    const customDashboard = "# CUSTOM dashboard — do not overwrite\n";
    const customClaude = "# CUSTOM CLAUDE.md — operator-edited\n";
    writeFileSync(join(instance, "dashboard.md"), customDashboard);
    writeFileSync(join(instance, "CLAUDE.md"), customClaude);

    const second = await run([instance, "--host=grove", "--agent=forge"]);
    expect(second.exitCode).toBe(0);
    expect(readFileSync(join(instance, "dashboard.md"), "utf8")).toBe(customDashboard);
    expect(readFileSync(join(instance, "CLAUDE.md"), "utf8")).toBe(customClaude);
  });

  test("partial state — state.sqlite exists, dashboard.md missing — creates only the missing pieces", async () => {
    const first = await run([instance, "--host=grove", "--agent=forge"]);
    expect(first.exitCode).toBe(0);

    // Remove dashboard.md and the context dir to simulate a partial install.
    rmSync(join(instance, "dashboard.md"));
    rmSync(join(instance, "context"), { recursive: true });

    const second = await run([instance, "--host=grove", "--agent=forge"]);
    expect(second.exitCode).toBe(0);
    // state.sqlite + CLAUDE.md + retros are skipped.
    expect(second.stdout).toContain("scaffold: skipped state.sqlite (exists)");
    expect(second.stdout).toContain("scaffold: skipped CLAUDE.md (exists)");
    expect(second.stdout).toContain("scaffold: skipped retros/ (exists)");
    // dashboard.md + context/* are recreated.
    expect(second.stdout).toContain("scaffold: created dashboard.md");
    expect(second.stdout).toContain("scaffold: created context/");
    expect(second.stdout).toContain("scaffold: created context/repos.md");
    expect(second.stdout).toContain("scaffold: created context/channels.md");

    expect(existsSync(join(instance, "dashboard.md"))).toBe(true);
    expect(existsSync(join(instance, "context", "repos.md"))).toBe(true);
  });
});

describe("scaffold.ts — --strict mode", () => {
  let dir: string;
  let instance: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "as-scaffold-"));
    instance = join(dir, "instance");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("--strict + missing migration exits non-zero", async () => {
    // Point the strict-mode existence check at an empty dir so 0001-initial.sql
    // is "missing" without disturbing the real bundle layout (other parallel
    // tests depend on it).
    const fakeMigrations = join(dir, "fake-migrations");
    // Intentionally do NOT create the dir or the file.
    const r = await run([instance, "--host=grove", "--agent=forge", "--strict"], {
      MF_MIGRATIONS_DIR_OVERRIDE: fakeMigrations,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("--strict");
    expect(r.stderr).toContain("0001");
  });

  test("--strict succeeds when migration is present", async () => {
    const r = await run([instance, "--host=grove", "--agent=forge", "--strict"]);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(instance, "state.sqlite"))).toBe(true);
  });
});

describe("scaffold.ts — programmatic API", () => {
  let dir: string;
  let instance: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "as-scaffold-"));
    instance = join(dir, "instance");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("scaffold() returns a structured action list", () => {
    const result = scaffold({ instanceDir: instance, host: "grove", agent: "forge" });
    expect(result.instanceDir).toBe(instance);
    const created = result.actions.filter((a) => a.kind === "created").map((a) => a.what);
    expect(created).toContain("state.sqlite");
    expect(created).toContain("dashboard.md");
    expect(created).toContain("CLAUDE.md");
    expect(created).toContain("retros/");
  });
});

describe("scaffold.ts — usage", () => {
  test("missing positional + flags exits 2", async () => {
    const r = await run([]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("usage:");
  });

  test("missing --host exits non-zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "as-scaffold-"));
    try {
      const r = await run([join(dir, "instance"), "--agent=forge"]);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain("host");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
