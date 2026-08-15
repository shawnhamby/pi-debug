import * as path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveAdapter } from "./adapters.ts";
import { DebugSessionManager } from "./session.ts";
import type { AdapterId, DebugAction, DebugExtensionOptions, DebugSessionSummary } from "./types.ts";

const INTERNAL_DETAILS_KEY = Symbol.for("pi.internal-details-expanded");
const HIDDEN_COMPONENT = { render: () => [], invalidate: () => {} };

function internalDetailsExpanded(): boolean {
  return Boolean((process as unknown as Record<symbol, unknown>)[INTERNAL_DETAILS_KEY]);
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function resultText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((entry) => entry && typeof entry === "object" && (entry as { type?: unknown }).type === "text"
    ? [String((entry as { text?: unknown }).text ?? "")]
    : []).join("\n");
}

function hiddenRendering() {
  return {
    renderShell: "self" as const,
    renderCall: () => HIDDEN_COMPONENT,
    renderResult: (result: unknown, _options: unknown, theme: { fg(color: string, text: string): string }) => ({
      render(width: number) {
        if (!internalDetailsExpanded()) return [];
        const lines = resultText(result).split("\n").filter(Boolean);
        if (!lines.length) return [];
        const limit = Math.max(1, width - 2);
        return [
          `${theme.fg("accent", "◆ Debug")} ${theme.fg("muted", lines[0].slice(0, limit))}`,
          ...lines.slice(1).map((line) => theme.fg("muted", `  ${line.slice(0, limit)}`)),
        ];
      },
      invalidate() {},
    }),
  };
}

function location(summary: DebugSessionSummary): string {
  const source = summary.source?.path ?? summary.source?.name;
  return source && summary.line ? `${source}:${summary.line}${summary.column ? `:${summary.column}` : ""}` : "";
}

function formatSummary(summary: DebugSessionSummary): string {
  return [
    `${summary.id}: ${summary.status}`,
    `adapter=${summary.adapter}`,
    `program=${summary.program}`,
    ...(summary.stopReason ? [`reason=${summary.stopReason}`] : []),
    ...(location(summary) ? [`location=${location(summary)}`] : []),
  ].join("\n");
}

function formatList<T>(label: string, values: T[], format: (value: T) => string): string {
  return values.length ? `${label}:\n${values.map((value) => `- ${format(value)}`).join("\n")}` : `${label}:\n(none)`;
}

const ACTIONS = [
  "launch", "set_breakpoint", "remove_breakpoint", "continue", "pause", "step_over", "step_in", "step_out",
  "threads", "stack_trace", "scopes", "variables", "output", "sessions", "terminate",
] as const;

export function createDebugExtension(options: DebugExtensionOptions) {
  return function debugExtension(pi: ExtensionAPI): void {
    const manager = new DebugSessionManager(options.onSessionSnapshot);
    pi.registerTool({
      ...hiddenRendering(),
      name: "debug",
      label: "Debug",
      description: [
        "Debug a locally launched workspace target through an admitted DAP adapter.",
        "Use only after a reproduction and focused source/static pass leave a runtime-state hypothesis.",
        "Supports launch, source breakpoints, stepping, state inspection, output, and owned termination.",
        "Attach, evaluation, memory access, custom requests, remote targets, and debugger command consoles are unavailable.",
      ].join(" "),
      parameters: Type.Object({
        action: Type.Union(ACTIONS.map((value) => Type.Literal(value))),
        program: Type.Optional(Type.String({ description: "Workspace target path for launch" })),
        args: Type.Optional(Type.Array(Type.String())),
        adapter: Type.Optional(Type.Union([
          Type.Literal("debugpy"), Type.Literal("vscode-js-debug"), Type.Literal("lldb-dap"),
          Type.Literal("dlv"), Type.Literal("wasmtime-lldb"),
        ])),
        cwd: Type.Optional(Type.String()),
        module: Type.Optional(Type.String({ description: "Workspace .wasm module for wasmtime-lldb" })),
        breakpoints: Type.Optional(Type.Array(Type.Object({
          file: Type.String({ description: "Workspace source path" }),
          line: Type.Integer({ minimum: 1 }),
        }), { description: "Source breakpoints configured before the initial target starts" })),
        file: Type.Optional(Type.String()),
        line: Type.Optional(Type.Integer({ minimum: 1 })),
        levels: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        frame_id: Type.Optional(Type.Integer({ minimum: 0 })),
        variable_ref: Type.Optional(Type.Integer({ minimum: 0 })),
        timeout: Type.Optional(Type.Number({ description: "Wait deadline in seconds" })),
      }),
      async execute(toolCallId: string, params: {
        action: DebugAction;
        program?: string;
        args?: string[];
        adapter?: AdapterId;
        cwd?: string;
        module?: string;
        breakpoints?: Array<{ file: string; line: number }>;
        file?: string;
        line?: number;
        levels?: number;
        frame_id?: number;
        variable_ref?: number;
        timeout?: number;
      }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
        const timeoutMs = Math.max(5, Math.min(300, params.timeout ?? 30)) * 1000;
        switch (params.action) {
          case "launch": {
            if (!params.program) throw new Error("debug launch requires program");
            const cwd = path.resolve(ctx.cwd, params.cwd ?? ".");
            const prepared = await options.prepareLaunch({
              toolCallId,
              ...(params.adapter ? { adapter: params.adapter } : {}),
              program: path.resolve(cwd, params.program),
              args: params.args ?? [],
              cwd,
              ...(params.module ? { module: path.resolve(cwd, params.module) } : {}),
            });
            const spec = resolveAdapter(prepared, prepared.adapter, options);
            const breakpoints = (params.breakpoints ?? []).map((entry) => ({
              file: path.resolve(cwd, entry.file),
              line: entry.line,
            }));
            return textResult(formatSummary(await manager.launch(spec, prepared.env, signal, breakpoints)), { action: params.action });
          }
          case "set_breakpoint": {
            if (!params.file || params.line === undefined) throw new Error("set_breakpoint requires file and line");
            const result = await manager.setBreakpoint(path.resolve(ctx.cwd, params.file), params.line);
            return textResult(formatList("Breakpoints", result.breakpoints, (entry) => `${entry.line}: ${entry.verified ? "verified" : "pending"}${entry.message ? ` (${entry.message})` : ""}`));
          }
          case "remove_breakpoint": {
            if (!params.file || params.line === undefined) throw new Error("remove_breakpoint requires file and line");
            const result = await manager.removeBreakpoint(path.resolve(ctx.cwd, params.file), params.line);
            return textResult(formatList("Breakpoints", result.breakpoints, (entry) => `${entry.line}: ${entry.verified ? "verified" : "pending"}`));
          }
          case "continue": return textResult(formatSummary(await manager.continue(signal, timeoutMs)));
          case "pause": return textResult(formatSummary(await manager.pause()));
          case "step_over": return textResult(formatSummary(await manager.step("next", signal, timeoutMs)));
          case "step_in": return textResult(formatSummary(await manager.step("stepIn", signal, timeoutMs)));
          case "step_out": return textResult(formatSummary(await manager.step("stepOut", signal, timeoutMs)));
          case "threads": {
            const result = await manager.threads();
            return textResult(formatList("Threads", result.threads, (thread) => `${thread.id}: ${thread.name}`));
          }
          case "stack_trace": {
            const result = await manager.stackTrace(params.levels === undefined ? undefined : Math.min(100, params.levels));
            return textResult(formatList("Stack trace", result.frames, (frame) => `#${frame.id} ${frame.name} @ ${frame.source?.path ?? "<unknown>"}:${frame.line}:${frame.column}`));
          }
          case "scopes": {
            const result = await manager.scopes(params.frame_id);
            return textResult(formatList("Scopes", result.scopes, (scope) => `${scope.name}: ref=${scope.variablesReference}`));
          }
          case "variables": {
            if (params.variable_ref === undefined) throw new Error("variables requires variable_ref");
            const result = await manager.variables(params.variable_ref);
            return textResult(formatList("Variables", result.variables, (variable) => `${variable.name} = ${variable.value}${variable.type ? ` (${variable.type})` : ""}`));
          }
          case "output": {
            const result = manager.output();
            return textResult(result.output || "(no output captured)");
          }
          case "sessions": return textResult(formatList("Debug sessions", manager.list(), formatSummary));
          case "terminate": {
            const summary = await manager.terminate();
            return textResult(summary ? formatSummary(summary) : "No debug session to terminate");
          }
        }
      },
    });

    pi.on("session_shutdown", async () => { await manager.shutdown(); });
  };
}

export type { AdapterId, DebugAction, DebugExtensionOptions, DebugSessionSummary, InitialBreakpoint, PreparedLaunch } from "./types.ts";
