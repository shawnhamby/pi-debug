import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import type { Readable, Writable } from "node:stream";
import { DapProtocol } from "./protocol.ts";
import type { AdapterSpec, DapEvent, DapRequest, OwnedProcess } from "./types.ts";

const CONNECT_TIMEOUT_MS = 10_000;

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a loopback DAP port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function connectLoopback(port: number, child: ChildProcess, timeoutMs = CONNECT_TIMEOUT_MS): Promise<net.Socket> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`DAP adapter exited before opening 127.0.0.1:${port}`);
    }
    try {
      return await new Promise<net.Socket>((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port });
        const onError = (error: Error) => {
          socket.destroy();
          reject(error);
        };
        socket.once("error", onError);
        socket.once("connect", () => {
          socket.off("error", onError);
          socket.setNoDelay(true);
          resolve(socket);
        });
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw new Error(`DAP adapter did not open 127.0.0.1:${port}: ${lastError?.message ?? "timeout"}`);
}

function boundedAppend(current: string, chunk: Buffer | string, limit = 32_768): string {
  const next = current + chunk.toString();
  return next.length <= limit ? next : next.slice(next.length - limit);
}

export class DapClient {
  readonly protocol: DapProtocol;
  readonly child: ChildProcess;
  readonly port?: number;
  stderr = "";

  private constructor(
    readonly spec: AdapterSpec,
    child: ChildProcess,
    readable: Readable,
    writable: Writable,
    port?: number,
    readonly ownsProcess = true,
  ) {
    this.child = child;
    this.port = port;
    this.protocol = new DapProtocol(readable, writable);
    child.stderr?.on("data", (chunk) => { this.stderr = boundedAppend(this.stderr, chunk); });
    child.once("exit", (code, signal) => {
      this.protocol.close(new Error(`DAP adapter exited (${signal ?? code ?? "unknown"})${this.stderr ? `: ${this.stderr.trim()}` : ""}`));
    });
  }

  static async spawn(spec: AdapterSpec, env: Record<string, string>): Promise<DapClient> {
    if (spec.transport === "stdio") {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (!child.stdin || !child.stdout) throw new Error("DAP adapter stdio is unavailable");
      return new DapClient(spec, child, child.stdout, child.stdin);
    }
    const port = await reservePort();
    const args = spec.args.map((arg) => arg.replaceAll("${port}", String(port)));
    const child = spawn(spec.command, args, {
      cwd: spec.cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const socket = await connectLoopback(port, child);
      return new DapClient(spec, child, socket, socket, port);
    } catch (error) {
      await terminateProcessGroup(child);
      throw error;
    }
  }

  static async connectOwnedTarget(parent: DapClient): Promise<DapClient> {
    if (parent.port === undefined) throw new Error("DAP adapter does not expose an owned loopback target endpoint");
    const socket = await connectLoopback(parent.port, parent.child);
    return new DapClient(parent.spec, parent.child, socket, socket, parent.port, false);
  }

  onEvent(handler: (event: DapEvent) => void): void {
    this.protocol.on("event", handler);
  }

  onRequest(handler: (request: DapRequest) => void): void {
    this.protocol.on("request", handler);
  }

  async dispose(): Promise<void> {
    this.protocol.close();
    if (this.ownsProcess) await terminateProcessGroup(this.child);
  }
}

export async function terminateProcessGroup(child: ChildProcess, graceMs = 1500): Promise<void> {
  if (!child.pid) return;
  const alreadyExited = child.exitCode !== null || child.signalCode !== null;
  const exited = alreadyExited
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    if (alreadyExited) return;
    try { child.kill("SIGTERM"); } catch { return; }
  }
  const graceful = alreadyExited
    ? await new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs))
    : await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
      ]);
  if (graceful) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* Process already exited. */ }
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 500))]);
}

export async function terminateOwnedProcesses(processes: Iterable<OwnedProcess>): Promise<void> {
  await Promise.all([...processes].map(({ child }) => terminateProcessGroup(child)));
}
