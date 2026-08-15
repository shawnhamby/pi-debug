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
  InitialBreakpoint,
  OwnedProcess,
} from "./types.ts";

const MAX_OUTPUT_BYTES = 128 * 1024;
const START_TIMEOUT_MS = 30_000;
const MAX_LAUNCH_ERROR_LENGTH = 1000;
type SessionStatus = DebugSessionSummary["status"];

type PromiseOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error };

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

type DebugSession = {
  id: string;
  client: DapClient;
  rootClient: DapClient;
  connections: Set<DapClient>;
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
  initialBreakpoints: InitialBreakpoint[];
  reverseReady?: Deferred<void>;
  reverseStarted: boolean;
  reverseStop?: Promise<PromiseOutcome<DapEvent>>;
  launchSignal?: AbortSignal;
};

function responseBody<T>(response: { body?: unknown }): T {
  return (response.body ?? {}) as T;
}

function errorFrom(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function supervise<T>(promise: Promise<T>): Promise<PromiseOutcome<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error: errorFrom(error) }),
  );
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function waitFor<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => settle(() => reject(errorFrom(signal.reason)));
    timer = setTimeout(() => settle(() => reject(new Error(`${label} timed out`))), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(errorFrom(error))),
    );
  });
}

function outcomeValue<T>(outcome: PromiseOutcome<T>): T {
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

function boundedLaunchError(error: unknown): Error {
  const message = errorFrom(error).message;
  const suffix = message.length > MAX_LAUNCH_ERROR_LENGTH ? "..." : "";
  return new Error(`DAP launch failed: ${message.slice(0, MAX_LAUNCH_ERROR_LENGTH)}${suffix}`);
}

function within(root: string, candidate: string): boolean {
  try {
    const relative = path.relative(fs.realpathSync(root), fs.realpathSync(candidate));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

function sourceDescriptor(source: string): { name: string; path: string } {
  return { name: path.basename(source), path: source };
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

  async launch(
    spec: AdapterSpec,
    env: Record<string, string>,
    signal?: AbortSignal,
    initialBreakpoints: InitialBreakpoint[] = [],
  ): Promise<DebugSessionSummary> {
    if ([...this.#sessions.values()].some((session) => session.status !== "terminated")) {
      throw new Error("A debug session is already active; terminate it before launching another target");
    }
    const client = await DapClient.spawn(spec, env);
    const session = this.#createSession(client, spec);
    session.initialBreakpoints = initialBreakpoints;
    let launchError: Error | undefined;
    try {
      await this.#initializeAndLaunch(session, spec.launch, initialBreakpoints, signal);
      this.#activeId = session.id;
      this.#publish();
      return this.#summary(session);
    } catch (error) {
      launchError = boundedLaunchError(error);
    } finally {
      if (launchError) {
        try {
          await this.#terminateSession(session);
        } catch (cleanupError) {
          launchError = boundedLaunchError(new AggregateError([launchError, cleanupError], "launch and cleanup failed"));
        }
        if (this.#activeId === session.id) this.#activeId = null;
        this.#sessions.delete(session.id);
        this.#publish();
      }
    }
    throw launchError;
  }

  async setBreakpoint(file: string, line: number): Promise<{ summary: DebugSessionSummary; breakpoints: BreakpointRecord[] }> {
    const session = this.#requiredActive();
    if (!within(session.spec.workspaceRoot, file)) throw new Error(`breakpoint file is outside the active workspace: ${file}`);
    const source = path.resolve(file);
    const current = session.breakpoints.get(source) ?? [];
    const next = [...current.filter((entry) => entry.line !== line), { line, verified: false }]
      .sort((left, right) => left.line - right.line);
    const response = await session.client.protocol.request("setBreakpoints", {
      source: sourceDescriptor(source),
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
    const source = path.resolve(file);
    const next = (session.breakpoints.get(source) ?? []).filter((entry) => entry.line !== line);
    const response = await session.client.protocol.request("setBreakpoints", {
      source: sourceDescriptor(source),
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
    initialBreakpoints: InitialBreakpoint[],
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const root = session.rootClient;
    const initialize = await root.protocol.request("initialize", {
      clientID: "pi-debug",
      clientName: "Pi",
      adapterID: session.spec.id,
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
      supportsVariableType: true,
      supportsRunInTerminalRequest: false,
      supportsStartDebuggingRequest: session.spec.id === "vscode-js-debug",
    }, START_TIMEOUT_MS);
    session.capabilities = responseBody<DapCapabilities>(initialize);
    const handshakeController = new AbortController();
    const handshakeSignal = signal ? AbortSignal.any([signal, handshakeController.signal]) : handshakeController.signal;
    session.launchSignal = handshakeSignal;
    try {
      const initialized = supervise(root.protocol.waitForEvent("initialized", START_TIMEOUT_MS, handshakeSignal));
      const stopped = supervise(root.protocol.waitForEvent("stopped", START_TIMEOUT_MS, handshakeSignal));
      const reverseReady = session.reverseReady
        ? supervise(waitFor(session.reverseReady.promise, START_TIMEOUT_MS, handshakeSignal, "vscode-js-debug owned target"))
        : undefined;
      const launched = supervise(root.protocol.request("launch", launch, START_TIMEOUT_MS));
      const initializedOutcome = await Promise.race([
        initialized,
        launched.then((outcome) => outcome.ok ? initialized : outcome),
      ]);
      outcomeValue(initializedOutcome);
      if (session.spec.id !== "vscode-js-debug") {
        await this.#setInitialBreakpoints(session, root, initialBreakpoints);
      }
      if (session.capabilities.supportsConfigurationDoneRequest !== false) {
        await root.protocol.request("configurationDone", {}, START_TIMEOUT_MS);
      }
      outcomeValue(await launched);
      if (session.spec.id === "vscode-js-debug") {
        if (!reverseReady) throw new Error("vscode-js-debug reverse target state is unavailable");
        outcomeValue(await reverseReady);
        if (!session.reverseStop) throw new Error("vscode-js-debug did not initialize its owned target");
      }
      const stopOutcome = await Promise.race([
        session.spec.id === "vscode-js-debug" ? session.reverseStop! : stopped,
        new Promise<PromiseOutcome<null>>((resolve) => setTimeout(() => resolve({ ok: true, value: null }), 2000)),
      ]);
      const stopEvent = stopOutcome.ok ? stopOutcome.value : null;
      session.status = stopEvent ? "stopped" : "running";
      this.#publish();
    } finally {
      handshakeController.abort(new Error("DAP launch handshake settled"));
      session.launchSignal = undefined;
    }
  }

  async #setInitialBreakpoints(
    session: DebugSession,
    client: DapClient,
    requested: InitialBreakpoint[],
  ): Promise<void> {
    const bySource = new Map<string, number[]>();
    for (const breakpoint of requested) {
      if (!Number.isInteger(breakpoint.line) || breakpoint.line < 1) {
        throw new Error(`breakpoint line must be a positive integer: ${breakpoint.line}`);
      }
      if (!within(session.spec.workspaceRoot, breakpoint.file)) {
        throw new Error(`breakpoint file is outside the active workspace: ${breakpoint.file}`);
      }
      const source = path.resolve(breakpoint.file);
      const lines = bySource.get(source) ?? [];
      if (!lines.includes(breakpoint.line)) lines.push(breakpoint.line);
      bySource.set(source, lines);
    }
    for (const [source, lines] of bySource) {
      lines.sort((left, right) => left - right);
      const response = await client.protocol.request("setBreakpoints", {
        source: sourceDescriptor(source),
        breakpoints: lines.map((line) => ({ line })),
        sourceModified: false,
      }, START_TIMEOUT_MS);
      const reported = responseBody<{ breakpoints?: DapBreakpoint[] }>(response).breakpoints ?? [];
      session.breakpoints.set(source, lines.map((line, index) => ({
        line,
        verified: reported[index]?.verified ?? false,
        message: reported[index]?.message,
      })));
    }
  }

  #createSession(client: DapClient, spec: AdapterSpec): DebugSession {
    const session: DebugSession = {
      id: `debug-${this.#nextId++}`,
      client,
      rootClient: client,
      connections: new Set([client]),
      spec,
      status: "launching",
      launchedAt: Date.now(),
      output: "",
      outputBytes: 0,
      outputTruncated: false,
      breakpoints: new Map(),
      owned: new Set(client.ownsProcess ? [{ child: client.child, command: spec.command }] : []),
      capabilities: {},
      initialBreakpoints: [],
      ...(spec.id === "vscode-js-debug" ? { reverseReady: deferred<void>() } : {}),
      reverseStarted: false,
    };
    this.#sessions.set(session.id, session);
    this.#wireClient(session, client);
    return session;
  }

  #wireClient(session: DebugSession, client: DapClient): void {
    client.onEvent((event) => this.#handleEvent(session, event));
    client.onRequest((request) => { void this.#handleReverseRequest(session, client, request); });
  }

  async #handleReverseRequest(session: DebugSession, source: DapClient, request: DapRequest): Promise<void> {
    if (request.command !== "startDebugging" || session.spec.id !== "vscode-js-debug" ||
        source !== session.rootClient || session.status !== "launching" || session.reverseStarted) {
      await source.protocol.respond(request, false, undefined, `Reverse request is not supported: ${request.command}`);
      return;
    }
    session.reverseStarted = true;
    try {
      const args = request.arguments as { request?: unknown; configuration?: unknown } | undefined;
      const configuration = args?.configuration;
      if (args?.request !== "launch" || !configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
        throw new Error("startDebugging must describe the owned initial launch target");
      }
      const config = configuration as Record<string, unknown>;
      const keys = Object.keys(config);
      if (keys.some((key) => !["type", "name", "__pendingTargetId"].includes(key)) ||
          config.type !== "pwa-node" || typeof config.name !== "string" ||
          typeof config.__pendingTargetId !== "string" || !config.__pendingTargetId) {
        throw new Error("startDebugging target is outside the owned initial Node session");
      }
      const target = await DapClient.connectOwnedTarget(session.rootClient);
      session.connections.add(target);
      this.#wireClient(session, target);
      const initialized = supervise(target.protocol.waitForEvent("initialized", START_TIMEOUT_MS));
      await target.protocol.request("initialize", {
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
      outcomeValue(await initialized);
      session.reverseStop = supervise(target.protocol.waitForEvent("stopped", START_TIMEOUT_MS, session.launchSignal));
      const reverseLaunch = supervise(target.protocol.request("launch", config, START_TIMEOUT_MS));
      await this.#setInitialBreakpoints(session, target, session.initialBreakpoints);
      await target.protocol.request("configurationDone", {}, START_TIMEOUT_MS);
      outcomeValue(await reverseLaunch);
      session.client = target;
      session.reverseReady?.resolve();
      await source.protocol.respond(request, true);
    } catch (error) {
      session.reverseReady?.reject(errorFrom(error));
      session.reverseStop = Promise.resolve({ ok: false, error: errorFrom(error) });
      await source.protocol.respond(request, false, undefined, errorFrom(error).message);
    }
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
    const settled = new AbortController();
    const waitSignal = signal ? AbortSignal.any([signal, settled.signal]) : settled.signal;
    try {
      const stopped = session.client.protocol.waitForEvent("stopped", timeoutMs, waitSignal).catch(() => null);
      const terminated = session.client.protocol.waitForEvent("terminated", timeoutMs, waitSignal).catch(() => null);
      const exited = session.client.protocol.waitForEvent("exited", timeoutMs, waitSignal).catch(() => null);
      session.status = "running";
      await session.client.protocol.request(command, { threadId: thread.id, singleThread: false }, timeoutMs);
      await Promise.race([stopped, terminated, exited]);
      return this.#summary(session);
    } finally {
      settled.abort(new Error("DAP resume settled"));
    }
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
    for (const connection of session.connections) connection.protocol.close();
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
