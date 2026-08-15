import type { ChildProcess } from "node:child_process";

export type AdapterId = "debugpy" | "vscode-js-debug" | "lldb-dap" | "dlv" | "wasmtime-lldb";
export type DebugAction =
  | "launch"
  | "set_breakpoint"
  | "remove_breakpoint"
  | "continue"
  | "pause"
  | "step_over"
  | "step_in"
  | "step_out"
  | "threads"
  | "stack_trace"
  | "scopes"
  | "variables"
  | "output"
  | "sessions"
  | "terminate";

export type DapMessage = DapRequest | DapResponse | DapEvent;

export interface DapRequest {
  seq: number;
  type: "request";
  command: string;
  arguments?: unknown;
}

export interface DapResponse {
  seq: number;
  type: "response";
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: unknown;
}

export interface DapEvent {
  seq: number;
  type: "event";
  event: string;
  body?: unknown;
}

export interface DapSource {
  name?: string;
  path?: string;
  sourceReference?: number;
}

export interface DapBreakpoint {
  id?: number;
  verified: boolean;
  message?: string;
  source?: DapSource;
  line?: number;
  column?: number;
}

export interface DapThread {
  id: number;
  name: string;
}

export interface DapStackFrame {
  id: number;
  name: string;
  source?: DapSource;
  line: number;
  column: number;
}

export interface DapScope {
  name: string;
  variablesReference: number;
  expensive: boolean;
  presentationHint?: string;
}

export interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

export interface DapCapabilities {
  supportsConfigurationDoneRequest?: boolean;
  supportsTerminateRequest?: boolean;
  supportsCancelRequest?: boolean;
}

export interface DapStoppedBody {
  reason: string;
  description?: string;
  threadId?: number;
  allThreadsStopped?: boolean;
}

export interface DapOutputBody {
  category?: string;
  output: string;
  source?: DapSource;
  line?: number;
  column?: number;
}

export interface AdapterSpec {
  id: AdapterId;
  command: string;
  args: string[];
  transport: "stdio" | "tcp";
  program: string;
  programArgs: string[];
  launch: Record<string, unknown>;
  cwd: string;
  workspaceRoot: string;
}

export interface PreparedLaunchRequest {
  toolCallId: string;
  adapter?: AdapterId;
  program: string;
  args: string[];
  cwd: string;
  module?: string;
}

export interface InitialBreakpoint {
  file: string;
  line: number;
}

export interface PreparedLaunch extends PreparedLaunchRequest {
  workspaceRoot: string;
  env: Record<string, string>;
}

export interface DebugExtensionOptions {
  prepareLaunch(request: PreparedLaunchRequest): Promise<PreparedLaunch> | PreparedLaunch;
  resolveJavaScriptServer?: (cwd: string) => string | null;
  resolveLldbDap?: () => string | null;
  onSessionSnapshot?: (sessions: DebugSessionSummary[]) => void;
}

export interface DebugSessionSummary {
  id: string;
  adapter: AdapterId;
  status: "launching" | "stopped" | "running" | "terminated";
  program: string;
  cwd: string;
  launchedAt: string;
  stopReason?: string;
  source?: DapSource;
  line?: number;
  column?: number;
  outputBytes: number;
  outputTruncated: boolean;
}

export interface OwnedProcess {
  child: ChildProcess;
  command: string;
}

export interface BreakpointRecord {
  line: number;
  verified: boolean;
  message?: string;
}
