import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AdapterId, AdapterSpec, DebugExtensionOptions, PreparedLaunch } from "./types.ts";

const COMMAND_FIELDS = new Set([
  "initCommands",
  "preRunCommands",
  "launchCommands",
  "stopCommands",
  "exitCommands",
  "terminateCommands",
  "attachCommands",
  "postRunCommands",
]);

function executableOnPath(name: string, pathValue = process.env.PATH ?? ""): string | null {
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Continue to the next PATH entry.
    }
  }
  return null;
}

function requireExecutable(name: string): string {
  const resolved = executableOnPath(name);
  if (!resolved) throw new Error(`adapter prerequisite is unavailable: ${name}`);
  return resolved;
}

function defaultLldbDap(): string | null {
  const direct = executableOnPath("lldb-dap");
  if (direct) return direct;
  const result = spawnSync("/usr/bin/xcrun", ["-f", "lldb-dap"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  if (result.status !== 0) return null;
  const candidate = result.stdout.trim();
  if (!path.isAbsolute(candidate)) return null;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

function defaultJavaScriptServer(cwd: string): string | null {
  const configured = process.env.PI_JS_DEBUG_SERVER;
  const candidates = [
    ...(configured ? [path.resolve(cwd, configured)] : []),
    path.join(os.homedir(), ".local", "share", "vscode-js-debug", "src", "dapDebugServer.js"),
    path.join(os.homedir(), ".local", "opt", "js-debug", "src", "dapDebugServer.js"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch {
      // Continue to the next host-owned location.
    }
  }
  return null;
}

function assertNoCommandFields(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (COMMAND_FIELDS.has(key)) throw new Error(`debug launch field is forbidden: ${key}`);
  }
}

function assertWithin(root: string, candidate: string, label: string): string {
  const realRoot = fs.realpathSync(root);
  const resolved = fs.realpathSync(candidate);
  const relative = path.relative(realRoot, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolved;
  throw new Error(`${label} is outside the active workspace: ${candidate}`);
}

function assertPrepared(request: PreparedLaunch): PreparedLaunch {
  if (!path.isAbsolute(request.cwd) || !path.isAbsolute(request.workspaceRoot)) {
    throw new Error("debug launch cwd and workspace root must be absolute");
  }
  assertWithin(request.workspaceRoot, request.cwd, "debug cwd");
  assertWithin(request.workspaceRoot, request.program, "debug program");
  if (request.module) assertWithin(request.workspaceRoot, request.module, "debug module");
  return request;
}

function pythonAdapter(request: PreparedLaunch): AdapterSpec {
  const python = requireExecutable("python3");
  const probe = spawnSync(python, ["-c", "import debugpy"], {
    cwd: request.cwd,
    env: request.env,
    stdio: "ignore",
  });
  if (probe.status !== 0) throw new Error("adapter prerequisite is unavailable: python3 module debugpy");
  return {
    id: "debugpy",
    command: python,
    args: ["-m", "debugpy.adapter"],
    transport: "stdio",
    program: request.program,
    programArgs: request.args,
    cwd: request.cwd,
    workspaceRoot: request.workspaceRoot,
    launch: {
      request: "launch",
      type: "python",
      name: "Pi debug",
      program: request.program,
      args: request.args,
      cwd: request.cwd,
      console: "internalConsole",
      justMyCode: false,
      stopOnEntry: true,
    },
  };
}

function javascriptAdapter(request: PreparedLaunch, options: DebugExtensionOptions): AdapterSpec {
  const server = options.resolveJavaScriptServer?.(request.cwd) ?? defaultJavaScriptServer(request.cwd);
  if (!server) throw new Error("adapter prerequisite is unavailable: vscode-js-debug dapDebugServer.js");
  const node = requireExecutable("node");
  return {
    id: "vscode-js-debug",
    command: node,
    args: [server, "${port}", "127.0.0.1"],
    transport: "tcp",
    program: request.program,
    programArgs: request.args,
    cwd: request.cwd,
    workspaceRoot: request.workspaceRoot,
    launch: {
      request: "launch",
      type: "pwa-node",
      name: "Pi debug",
      program: request.program,
      args: request.args,
      cwd: request.cwd,
      console: "internalConsole",
      autoAttachChildProcesses: false,
      stopOnEntry: true,
    },
  };
}

function lldbAdapter(request: PreparedLaunch, options: DebugExtensionOptions): AdapterSpec {
  const lldb = options.resolveLldbDap?.() ?? defaultLldbDap();
  if (!lldb) throw new Error("adapter prerequisite is unavailable: lldb-dap");
  return {
    id: "lldb-dap",
    command: lldb,
    args: [],
    transport: "stdio",
    program: request.program,
    programArgs: request.args,
    cwd: request.cwd,
    workspaceRoot: request.workspaceRoot,
    launch: {
      request: "launch",
      name: "Pi debug",
      program: request.program,
      args: request.args,
      cwd: request.cwd,
      stopOnEntry: true,
    },
  };
}

function delveAdapter(request: PreparedLaunch): AdapterSpec {
  const dlv = requireExecutable("dlv");
  const extension = path.extname(request.program).toLowerCase();
  const mode = fs.statSync(request.program).isDirectory() || extension === ".go" ? "debug" : "exec";
  return {
    id: "dlv",
    command: dlv,
    args: ["dap", "--listen=127.0.0.1:${port}"],
    transport: "tcp",
    program: request.program,
    programArgs: request.args,
    cwd: request.cwd,
    workspaceRoot: request.workspaceRoot,
    launch: {
      request: "launch",
      name: "Pi debug",
      mode,
      program: request.program,
      args: request.args,
      cwd: request.cwd,
      stopOnEntry: true,
    },
  };
}

function wasmtimeAdapter(request: PreparedLaunch, options: DebugExtensionOptions): AdapterSpec {
  const module = request.module ?? request.program;
  if (path.extname(module).toLowerCase() !== ".wasm") throw new Error("Wasmtime debugging requires a .wasm module");
  assertWithin(request.workspaceRoot, module, "Wasmtime module");
  const wasmtime = requireExecutable("wasmtime");
  const lldb = options.resolveLldbDap?.() ?? defaultLldbDap();
  if (!lldb) throw new Error("adapter prerequisite is unavailable: lldb-dap");
  return {
    id: "wasmtime-lldb",
    command: lldb,
    args: [],
    transport: "stdio",
    program: wasmtime,
    programArgs: ["-D", "debug-info", module, ...request.args],
    cwd: request.cwd,
    workspaceRoot: request.workspaceRoot,
    launch: {
      request: "launch",
      name: "Pi Wasmtime debug",
      program: wasmtime,
      args: ["-D", "debug-info", module, ...request.args],
      cwd: request.cwd,
      stopOnEntry: true,
    },
  };
}

export function inferAdapter(program: string): AdapterId | null {
  const extension = path.extname(program).toLowerCase();
  if (extension === ".py") return "debugpy";
  if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(extension)) return "vscode-js-debug";
  // LLDB launches a compiled native executable, not Rust source. Keep Rust
  // support explicit so a source file is never mistaken for a runnable target.
  if (extension === ".go" || fs.existsSync(path.join(program, "go.mod"))) return "dlv";
  if (extension === ".wasm") return "wasmtime-lldb";
  return null;
}

export function resolveAdapter(
  request: PreparedLaunch,
  selected: AdapterId | undefined,
  options: DebugExtensionOptions,
): AdapterSpec {
  const prepared = assertPrepared(request);
  const adapter = selected ?? inferAdapter(prepared.program);
  if (!adapter) throw new Error("No admitted debugger matches the target; specify an admitted adapter");
  let spec: AdapterSpec;
  switch (adapter) {
    case "debugpy": spec = pythonAdapter(prepared); break;
    case "vscode-js-debug": spec = javascriptAdapter(prepared, options); break;
    case "lldb-dap": spec = lldbAdapter(prepared, options); break;
    case "dlv": spec = delveAdapter(prepared); break;
    case "wasmtime-lldb": spec = wasmtimeAdapter(prepared, options); break;
  }
  assertNoCommandFields(spec.launch);
  return spec;
}

export function minimizedEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const keys = ["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG", "LC_ALL", "TERM"];
  return Object.fromEntries(keys.flatMap((key) => typeof source[key] === "string" ? [[key, source[key]]] : []));
}
