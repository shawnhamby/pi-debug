import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DebugSessionManager } from "../src/session.ts";
import type { AdapterSpec } from "../src/types.ts";

const fixture = path.resolve("test/fixtures/rejecting-launch-adapter.mjs");

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a rejected launch is supervised and cleans its process group and partial session", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-debug-launch-"));
  const pidFile = path.join(temporaryDirectory, "debuggee.pid");
  const manager = new DebugSessionManager();
  const spec: AdapterSpec = {
    id: "debugpy",
    command: process.execPath,
    args: [fixture, pidFile],
    transport: "stdio",
    program: path.join(temporaryDirectory, "program.py"),
    programArgs: [],
    launch: {},
    cwd: temporaryDirectory,
    workspaceRoot: temporaryDirectory,
  };

  try {
    await assert.rejects(
      manager.launch(spec, process.env as Record<string, string>),
      /^Error: DAP launch failed: intentional launch rejection$/,
    );
    assert.deepEqual(manager.list(), []);

    const debuggeePid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.equal(processExists(debuggeePid), false, `debuggee process ${debuggeePid} survived failed launch cleanup`);
  } finally {
    await manager.shutdown();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
