import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DebugSessionManager } from "../src/session.ts";
import type { AdapterSpec } from "../src/types.ts";

const fixture = path.resolve("test/fixtures/rejecting-launch-adapter.mjs");
const jsFixture = path.resolve("test/fixtures/js-debug-reverse-adapter.mjs");

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

function javascriptSpec(root: string, mode: string, traceFile: string): AdapterSpec {
  const program = path.join(root, "program.js");
  fs.writeFileSync(program, "console.log('ok')\n");
  return {
    id: "vscode-js-debug",
    command: process.execPath,
    args: [jsFixture, "${port}", mode, traceFile],
    transport: "tcp",
    program,
    programArgs: [],
    launch: {
      request: "launch",
      type: "pwa-node",
      name: "Pi debug",
      program,
      cwd: root,
      stopOnEntry: true,
    },
    cwd: root,
    workspaceRoot: root,
  };
}

test("js-debug launches its one owned reverse target and configures initial breakpoints first", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-debug-js-reverse-"));
  const traceFile = path.join(root, "trace.txt");
  const manager = new DebugSessionManager();
  const spec = javascriptSpec(root, "valid", traceFile);
  try {
    const summary = await manager.launch(spec, process.env as Record<string, string>, undefined, [
      { file: spec.program, line: 1 },
    ]);
    assert.equal(summary.status, "stopped");
    assert.deepEqual((await manager.threads()).threads, [{ id: 1, name: "main" }]);
    const trace = fs.readFileSync(traceFile, "utf8").trim().split("\n");
    assert.ok(trace.indexOf("target:setBreakpoints") < trace.indexOf("target:configurationDone"), trace.join(", "));
  } finally {
    await manager.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("js-debug missing programs fail the launch instead of returning a threadless success", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-debug-js-missing-"));
  const manager = new DebugSessionManager();
  try {
    await assert.rejects(
      manager.launch(javascriptSpec(root, "missing", path.join(root, "trace.txt")), process.env as Record<string, string>),
      /DAP launch failed: Cannot find module: missing-program\.js/,
    );
    assert.deepEqual(manager.list(), []);
  } finally {
    await manager.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("js-debug rejects reverse target expansion beyond its pending target marker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-debug-js-unsafe-"));
  const manager = new DebugSessionManager();
  try {
    await assert.rejects(
      manager.launch(javascriptSpec(root, "unsafe", path.join(root, "trace.txt")), process.env as Record<string, string>),
      /DAP launch failed: startDebugging target is outside the owned initial Node session/,
    );
    assert.deepEqual(manager.list(), []);
  } finally {
    await manager.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an immediate exited event settles resume without consuming its timeout", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-debug-js-exit-"));
  const manager = new DebugSessionManager();
  try {
    await manager.launch(javascriptSpec(root, "exit", path.join(root, "trace.txt")), process.env as Record<string, string>);
    const started = Date.now();
    const summary = await manager.continue(undefined, 5000);
    assert.equal(summary.status, "terminated");
    assert.ok(Date.now() - started < 1000, `resume took ${Date.now() - started}ms`);
  } finally {
    await manager.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
