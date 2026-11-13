// Smoke test. Start the real CLI with a temp HOME. macOS commands fail on Linux. The CLI must still exit 0.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
let home = "";

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "cg-smoke-"));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

function run(args: string[]): { code: number | null; out: string; err: string } {
  const r = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20000,
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("cli smoke", () => {
  test("help exits 0 and prints usage", () => {
    const r = run(["help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: cg");
  });

  test("menubar exits 0 with no status file", () => {
    const r = run(["menubar"]);
    expect(r.code).toBe(0);
    expect(r.out.length).toBeGreaterThan(0);
  });

  test("help lists the calendar commands", () => {
    const r = run(["help"]);
    expect(r.out).toContain("trips [--json]");
    expect(r.out).toContain("calendar on|off");
  });

  test("trips --json exits 0 with no trips file", () => {
    const r = run(["trips", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.access).toBeNull();
    expect(j.trips).toEqual([]);
    expect(j.next).toBeNull();
  });

  test("unknown command exits 2", () => {
    expect(run(["no-such-command"]).code).toBe(2);
  });
});
