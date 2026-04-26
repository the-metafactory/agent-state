/**
 * CLI subprocess tests — validates user-facing flag parsing in errands.ts and events.ts.
 *
 * These tests spawn the actual scripts via `bun run` so we exercise the same code path
 * operators see at the terminal. Each test runs in a temp dir with MF_INSTANCE_DIR set so
 * the SQLite file is isolated.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ERRANDS = resolve(import.meta.dirname, "..", "skill", "scripts", "errands.ts");
const EVENTS = resolve(import.meta.dirname, "..", "skill", "scripts", "events.ts");

type RunResult = { exitCode: number; stdout: string; stderr: string };

async function run(script: string, args: string[], instanceDir: string): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", script, ...args], {
    env: { ...process.env, MF_INSTANCE_DIR: instanceDir },
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

describe("errands.ts CLI flag validation (N1)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "as-cli-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("list --limit foo exits 2 with clear error (not NaN passed to SQLite)", async () => {
    const r = await run(ERRANDS, ["list", "--limit", "foo"], dir);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("invalid --limit");
    expect(r.stderr).toContain("positive integer");
    // And critically: no NaN-bound SQLite stack trace.
    expect(r.stderr).not.toContain("NaN");
  });

  test("list --limit -5 exits 2 (negative rejected)", async () => {
    const r = await run(ERRANDS, ["list", "--limit", "-5"], dir);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("invalid --limit");
  });

  test("list --limit 0 exits 2 (zero rejected)", async () => {
    const r = await run(ERRANDS, ["list", "--limit", "0"], dir);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("invalid --limit");
  });

  test("list --limit 10 succeeds (valid positive integer)", async () => {
    const r = await run(ERRANDS, ["list", "--limit", "10"], dir);
    expect(r.exitCode).toBe(0);
  });
});

describe("events.ts CLI flag validation (N1)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "as-cli-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("tail --limit foo exits 2 with clear error", async () => {
    const r = await run(EVENTS, ["tail", "--limit", "foo"], dir);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("invalid --limit");
  });

  test("tail --limit 5 succeeds", async () => {
    const r = await run(EVENTS, ["tail", "--limit", "5"], dir);
    expect(r.exitCode).toBe(0);
  });
});

describe("errands.ts CLI does not double-emit events (W2)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "as-cli-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("enqueue → claim → resolve produces exactly 3 events for the work item", async () => {
    const enq = await run(
      ERRANDS,
      [
        "enqueue",
        "--id",
        "w1",
        "--kind",
        "test",
        "--payload",
        '{"hello":"world"}',
        "--owner",
        "luna",
      ],
      dir,
    );
    expect(enq.exitCode).toBe(0);

    const cl = await run(ERRANDS, ["claim", "--id", "w1", "--owner", "luna"], dir);
    expect(cl.exitCode).toBe(0);

    const rv = await run(
      ERRANDS,
      ["resolve", "--id", "w1", "--status", "done", "--notes", "shipped"],
      dir,
    );
    expect(rv.exitCode).toBe(0);

    // Tail events and assert exactly 3 transition events for w1, not 6.
    const tail = await run(EVENTS, ["tail", "--limit", "50"], dir);
    expect(tail.exitCode).toBe(0);
    const lines = tail.stdout.trim().split("\n").filter((l) => l.length > 0);
    const w1Events = lines
      .map((l) => JSON.parse(l) as { type: string; work_item_id: string | null })
      .filter((e) => e.work_item_id === "w1")
      .map((e) => e.type)
      .sort();
    expect(w1Events).toEqual([
      "work_item_claimed",
      "work_item_created",
      "work_item_resolved",
    ]);
  });
});
