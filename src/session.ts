import * as fs from "node:fs";
import * as path from "node:path";
import { DapClient, terminateOwnedProcesses } from "./client.ts";
import type {
  AdapterSpec,
  BreakpointRecord,
  DapBreakpoint,
  DapCapabilities,
  DapEvent,
  DapRequest,
  DapScope,
  DapStackFrame,
  DapStoppedBody,
  DapThread,
  DapVariable,
  DebugSessionSummary,
  OwnedProcess,
} from "./types.ts";

const MAX_OUTPUT_BYTES = 128 * 1024;
const START_TIMEOUT_MS = 30_000;
type SessionStatus = DebugSessionSummary["status"];

type DebugSession = {
  id: string;
  client: DapClient;
  spec: AdapterSpec;
  status: SessionStatus;
  launchedAt: number;
  output: string;
  outputBytes: number;
  outputTruncated: boolean;
  stop?: DapStoppedBody;
  stopSource?: { source?: DebugSessionSummary["source"]; line?: number; column?: number };
  breakpoints: Map<string, BreakpointRecord[]>;
  owned: Set<OwnedProcess>;
  cleanup?: Promise<void>;
  capabilities: DapCapabilities;
};

function responseBody<T>(response: { body?: unknown }): T {
  return (response.body ?? {}) as T;
}

function within(root: string, candidate: string): boolean {
  try {
    const relative = path.relative(fs.realpathSync(root), fs.realpathSync(candidate));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

function appendOutput(session: DebugSession, text: string): void {
  if (!text) return;
  session.outputBytes += Buffer.byteLength(text, "utf8");
  session.output += text;
  const bytes = Buffer.from(session.output, "utf8");
  if (bytes.length > MAX_OUTPUT_BYTES) {
    session.output = bytes.subarray(bytes.length - MAX_OUTPUT_BYTES).toString("utf8");
    session.outputTruncated = true;
  }
}

export class DebugSessionManager {
  #sessions = new Map<string, DebugSession>();
  #activeId: string | null = null;
  #nextId = 1;

  constructor(private readonly onSnapshot?: (sessions: DebugSessionSummary[]) => void) {}

  list(): DebugSessionSummary[] {
    return [...this.#sessions.values()].map((session) => this.#summary(session));
  }

  get active(): DebugSessionSummary | null {
    const session = this.#active();
    return session ? this.#summary(session) : null;
  }

  async launch(spec: AdapterSpec, env: Record<string, string>, signal?: AbortSignal): Promise<DebugSessionSummary> {
    if ([...this.#sessions.values()].some((session) => session.status !== "terminated")) {
      throw new Error("A debug session is already active; terminate it before launching another target");
    }
    const client = await DapClient.spawn(spec, env);
    const session = this.#createSession(client, spec);
    try {
      await this.#initializeAndLaunch(session, spec.launch, signal);
      this.#activeId = session.id;
      this.#publish();
      return this.#summary(session);
    } catch (error) {
      await this.#terminateSession(session);
      throw error;
    }
  }

  async setBreakpoint(file: string, line: number): Promise<{ summary: DebugSessionSummary; breakpoints: BreakpointRecord[] }> {
    const session = this.#requiredActive();
    if (!within(session.spec.workspaceRoot, file)) throw new Error(`breakpoint file is outside the active workspace: ${file}`);
    const source = fs.realpathSync(file);
    const current = session.breakpoints.get(source) ?? [];
    const next = [...current.filter((entry) => entry.line !== line), { line, verified: false }]
      .sort((left, right) => left.line - right.line);
    const response = await session.client.protocol.request("setBreakpoints", {
      source: { path: source },
      breakpoints: next.map((entry) => ({ line: entry.line })),
      sourceModified: false,
    });
    const reported = responseBody<{ breakpoints?: DapBreakpoint[] }>(response).breakpoints ?? [];
    const records = next.map((entry, index) => ({
      ...entry,
      verified: reported[index]?.verified ?? false,
      message: reported[index]?.message,
    }));
    session.breakpoints.set(source, records);
    return { summary: this.#summary(session), breakpoints: records };
  }

  async removeBreakpoint(file: string, line: number): Promise<{ summary: DebugSessionSummary; breakpoints: BreakpointRecord[] }> {
    const session = this.#requiredActive();
    if (!within(session.spec.workspaceRoot, file)) throw new Error(`breakpoint file is outside the active workspace: ${file}`);
    const source = fs.realpathSync(file);
    const next = (session.breakpoints.get(source) ?? []).filter((entry) => entry.line !== line);
    const response = await session.client.protocol.request("setBreakpoints", {
      source: { path: source },
      breakpoints: next.map((entry) => ({ line: entry.line })),
      sourceModified: false,
    });
    const reported = responseBody<{ breakpoints?: DapBreakpoint[] }>(response).breakpoints ?? [];
    const records = next.map((entry, index) => ({ ...entry, verified: reported[index]?.verified ?? false, message: reported[index]?.message }));
    session.breakpoints.set(source, records);
    return { summary: this.#summary(session), breakpoints: records };
  }

  async continue(signal?: AbortSignal, timeoutMs = 30_000): Promise<DebugSessionSummary> {
    return this.#resume("continue", signal, timeoutMs);
  }

  async step(action: "next" | "stepIn" | "stepOut", signal?: AbortSignal, timeoutMs = 30_000): Promise<DebugSessionSummary> {
    return this.#resume(action, signal, timeoutMs);
  }

  async pause(): Promise<DebugSessionSummary> {
    const session = this.#requiredActive();
    const thread = await this.#primaryThread(session);
    await session.client.protocol.request("pause", { threadId: thread.id });
    await session.client.protocol.waitForEvent("stopped", 10_000);
    return this.#summary(session);
  }

  async threads(): Promise<{ summary: DebugSessionSummary; threads: DapThread[] }> {
    const session = this.#requiredActive();
    const response = await session.client.protocol.request("threads");
    return { summary: this.#summary(session), threads: responseBody<{ threads?: DapThread[] }>(response).threads ?? [] };
  }

  async stackTrace(levels = 20): Promise<{ summary: DebugSessionSummary; frames: DapStackFrame[] }> {
    const session = this.#requiredActive();
    const thread = await this.#primaryThread(session);
    const response = await session.client.protocol.request("stackTrace", { threadId: thread.id, startFrame: 0, levels });
    return { summary: this.#summary(session), frames: responseBody<{ stackFrames?: DapStackFrame[] }>(response).stackFrames ?? [] };
  }

  async scopes(frameId?: number): Promise<{ summary: DebugSessionSummary; scopes: DapScope[] }> {
    const session = this.#requiredActive();
    const resolvedFrame = frameId ?? (await this.stackTrace(1)).frames[0]?.id;
    if (resolvedFrame === undefined) throw new Error("No stopped frame is available");
    const response = await session.client.protocol.request("scopes", { frameId: resolvedFrame });
    return { summary: this.#summary(session), scopes: responseBody<{ scopes?: DapScope[] }>(response).scopes ?? [] };
  }

  async variables(reference: number): Promise<{ summary: DebugSessionSummary; variables: DapVariable[] }> {
    const session = this.#requiredActive();
    const response = await session.client.protocol.request("variables", { variablesReference: reference });
    return { summary: this.#summary(session), variables: responseBody<{ variables?: DapVariable[] }>(response).variables ?? [] };
  }

  output(): { summary: DebugSessionSummary; output: string } {
    const session = this.#requiredActive();
    return { summary: this.#summary(session), output: session.output };
  }

  async terminate(): Promise<DebugSessionSummary | null> {
    const session = this.#active();
    if (!session) return null;
    await this.#terminateTree(session);
    return this.#summary(session);
  }

  async shutdown(): Promise<void> {
    const roots = [...this.#sessions.values()].filter((session) => session.status !== "terminated");
    await Promise.all(roots.map((session) => this.#terminateTree(session)));
  }

  async #initializeAndLaunch(
    session: DebugSession,
    launch: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const initialize = await session.client.protocol.request("initialize", {
      clientID: "pi-debug",
      clientName: "Pi",
      adapterID: session.spec.id,
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
      supportsVariableType: true,
      supportsRunInTerminalRequest: false,
      supportsStartDebuggingRequest: false,
    }, START_TIMEOUT_MS);
    session.capabilities = responseBody<DapCapabilities>(initialize);
    const initialized = session.client.protocol.waitForEvent("initialized", START_TIMEOUT_MS, signal);
    const stopped = session.client.protocol.waitForEvent("stopped", START_TIMEOUT_MS, signal).catch(() => null);
    const launched = session.client.protocol.request("launch", launch, START_TIMEOUT_MS);
    await initialized;
    if (session.capabilities.supportsConfigurationDoneRequest !== false) {
      await session.client.protocol.request("configurationDone", {}, START_TIMEOUT_MS);
    }
    await launched;
    const stopEvent = await Promise.race([
      stopped,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    session.status = stopEvent ? "stopped" : "running";
    this.#publish();
  }

  #createSession(client: DapClient, spec: AdapterSpec): DebugSession {
    const session: DebugSession = {
      id: `debug-${this.#nextId++}`,
      client,
      spec,
      status: "launching",
      launchedAt: Date.now(),
      output: "",
      outputBytes: 0,
      outputTruncated: false,
      breakpoints: new Map(),
      owned: new Set(client.ownsProcess ? [{ child: client.child, command: spec.command }] : []),
      capabilities: {},
    };
    this.#sessions.set(session.id, session);
    client.onEvent((event) => this.#handleEvent(session, event));
    client.onRequest((request) => { void this.#handleReverseRequest(session, request); });
    return session;
  }

  async #handleReverseRequest(session: DebugSession, request: DapRequest): Promise<void> {
    await session.client.protocol.respond(request, false, undefined, `Reverse request is not supported: ${request.command}`);
  }

  #handleEvent(session: DebugSession, event: DapEvent): void {
    if (event.event === "output") {
      const body = event.body as { output?: unknown } | undefined;
      if (typeof body?.output === "string") appendOutput(session, body.output);
    } else if (event.event === "stopped") {
      session.status = "stopped";
      session.stop = event.body as DapStoppedBody;
      void this.#captureStopLocation(session);
      this.#activeId = session.id;
    } else if (event.event === "continued") {
      session.status = "running";
    } else if (event.event === "terminated" || event.event === "exited") {
      session.status = "terminated";
      if (this.#activeId === session.id) this.#activeId = null;
      void this.#cleanupOwned(session);
    }
    this.#publish();
  }

  async #captureStopLocation(session: DebugSession): Promise<void> {
    try {
      const thread = await this.#primaryThread(session);
      const response = await session.client.protocol.request("stackTrace", { threadId: thread.id, startFrame: 0, levels: 1 }, 5000);
      const frame = responseBody<{ stackFrames?: DapStackFrame[] }>(response).stackFrames?.[0];
      if (frame) session.stopSource = { source: frame.source, line: frame.line, column: frame.column };
      this.#publish();
    } catch {
      // A stop event remains useful even when the adapter cannot produce a frame.
    }
  }

  async #resume(command: "continue" | "next" | "stepIn" | "stepOut", signal?: AbortSignal, timeoutMs = 30_000): Promise<DebugSessionSummary> {
    const session = this.#requiredActive();
    const thread = await this.#primaryThread(session);
    const stopped = session.client.protocol.waitForEvent("stopped", timeoutMs, signal).catch(() => null);
    const terminated = session.client.protocol.waitForEvent("terminated", timeoutMs, signal).catch(() => null);
    session.status = "running";
    await session.client.protocol.request(command, { threadId: thread.id, singleThread: false }, timeoutMs);
    await Promise.race([stopped, terminated]);
    return this.#summary(session);
  }

  async #primaryThread(session: DebugSession): Promise<DapThread> {
    const response = await session.client.protocol.request("threads");
    const threads = responseBody<{ threads?: DapThread[] }>(response).threads ?? [];
    const selected = session.stop?.threadId ? threads.find((thread) => thread.id === session.stop?.threadId) : threads[0];
    if (!selected) throw new Error("No debug thread is available");
    return selected;
  }

  async #terminateTree(session: DebugSession): Promise<void> {
    await this.#terminateSession(session);
  }

  async #terminateSession(session: DebugSession): Promise<void> {
    if (session.status !== "terminated") {
      try {
        if (session.capabilities.supportsTerminateRequest) await session.client.protocol.request("terminate", {}, 2000);
        else await session.client.protocol.request("disconnect", { terminateDebuggee: true }, 2000);
      } catch {
        // Owned process cleanup below is authoritative.
      }
    }
    await this.#cleanupOwned(session);
    session.client.protocol.close();
    session.status = "terminated";
    this.#publish();
  }

  #cleanupOwned(session: DebugSession): Promise<void> {
    session.cleanup ??= terminateOwnedProcesses(session.owned);
    return session.cleanup;
  }

  #active(): DebugSession | null {
    return this.#activeId ? this.#sessions.get(this.#activeId) ?? null : null;
  }

  #requiredActive(): DebugSession {
    const session = this.#active();
    if (!session || session.status === "terminated") throw new Error("No active debug session; launch a target first");
    return session;
  }

  #summary(session: DebugSession): DebugSessionSummary {
    return {
      id: session.id,
      adapter: session.spec.id,
      status: session.status,
      program: session.spec.program,
      cwd: session.spec.cwd,
      launchedAt: new Date(session.launchedAt).toISOString(),
      stopReason: session.stop?.reason ?? session.stop?.description,
      source: session.stopSource?.source,
      line: session.stopSource?.line,
      column: session.stopSource?.column,
      outputBytes: session.outputBytes,
      outputTruncated: session.outputTruncated,
    };
  }

  #publish(): void {
    this.onSnapshot?.(this.list());
  }
}
