import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveAdapter } from "../src/adapters.ts";
import type { DebugExtensionOptions, PreparedLaunch } from "../src/types.ts";

const options: DebugExtensionOptions = {
  prepareLaunch(request) {
    throw new Error(`unused: ${request.program}`);
  },
  resolveLldbDap: () => "/bin/true",
};

test("debugpy preserves the selected virtual-environment interpreter path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-debug-python-"));
  const bin = path.join(root, "venv", "bin");
  const base = path.join(root, "base-python");
  const selected = path.join(bin, "python3");
  const program = path.join(root, "program.py");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(base, `#!/bin/sh\n[ "$0" = "${selected}" ]\n`, { mode: 0o755 });
  fs.symlinkSync(base, selected);
  fs.writeFileSync(program, "print('ok')\n");
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    const request: PreparedLaunch = {
      toolCallId: "test",
      adapter: "debugpy",
      program,
      args: [],
      cwd: root,
      workspaceRoot: root,
      env: { PATH: bin },
    };
    const spec = resolveAdapter(request, "debugpy", options);
    assert.equal(spec.command, selected);
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lldb-dap rejects Rust source instead of executing it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-debug-rust-source-"));
  const program = path.join(root, "main.rs");
  fs.writeFileSync(program, "fn main() {}\n");
  try {
    const request: PreparedLaunch = {
      toolCallId: "test",
      adapter: "lldb-dap",
      program,
      args: [],
      cwd: root,
      workspaceRoot: root,
      env: {},
    };
    assert.throws(
      () => resolveAdapter(request, "lldb-dap", options),
      /lldb-dap requires a compiled executable, not a Rust source file/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function wasmWithCustomSections(names: string[]): Buffer {
  const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  for (const name of names) {
    const encoded = Buffer.from(name, "utf8");
    bytes.push(0x00, encoded.length + 2, encoded.length, ...encoded, 0x01);
  }
  return Buffer.from(bytes);
}

test("wasmtime rejects stripped modules and admits modules with core guest DWARF sections", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-debug-wasm-"));
  const bin = path.join(root, "bin");
  const stripped = path.join(root, "stripped.wasm");
  const debug = path.join(root, "debug.wasm");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "wasmtime"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(stripped, wasmWithCustomSections([]));
  fs.writeFileSync(debug, wasmWithCustomSections([".debug_info", ".debug_abbrev", ".debug_line"]));
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    const prepared = (program: string): PreparedLaunch => ({
      toolCallId: "test",
      adapter: "wasmtime-lldb",
      program,
      module: program,
      args: [],
      cwd: root,
      workspaceRoot: root,
      env: { PATH: bin },
    });
    assert.throws(
      () => resolveAdapter(prepared(stripped), "wasmtime-lldb", options),
      /Wasmtime debugging requires guest DWARF sections: missing \.debug_info, \.debug_abbrev, \.debug_line/,
    );
    const spec = resolveAdapter(prepared(debug), "wasmtime-lldb", options);
    assert.equal(spec.id, "wasmtime-lldb");
    assert.deepEqual(spec.args, process.platform === "darwin" ? [
      "--pre-init-command",
      "settings set plugin.jit-loader.gdb.enable on",
    ] : []);
    assert.deepEqual(spec.programArgs.slice(0, 3), ["-D", "debug-info", debug]);
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
