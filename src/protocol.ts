import { EventEmitter } from "node:events";
import type { Duplex, Readable, Writable } from "node:stream";
import type { DapEvent, DapMessage, DapRequest, DapResponse } from "./types.ts";

const HEADER_END = Buffer.from("\r\n\r\n");
const DEFAULT_TIMEOUT_MS = 30_000;

type PendingRequest = {
  command: string;
  resolve: (value: DapResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class DapProtocol extends EventEmitter {
  #buffer = Buffer.alloc(0);
  #nextSeq = 1;
  #pending = new Map<number, PendingRequest>();
  #closed = false;

  constructor(
    private readonly readable: Readable,
    private readonly writable: Writable,
  ) {
    super();
    readable.on("data", (chunk: Buffer | string) => this.#consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    readable.on("end", () => this.close(new Error("DAP transport ended")));
    readable.on("error", (error) => this.close(error));
    writable.on("error", (error) => this.close(error));
  }

  request(command: string, args?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<DapResponse> {
    if (this.#closed) return Promise.reject(new Error("DAP transport is closed"));
    const seq = this.#nextSeq++;
    const message: DapRequest = { seq, type: "request", command, ...(args === undefined ? {} : { arguments: args }) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(seq);
        reject(new Error(`DAP ${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(seq, { command, resolve, reject, timer });
      this.#write(message).catch((error) => {
        const pending = this.#pending.get(seq);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(seq);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async respond(request: DapRequest, success: boolean, body?: unknown, message?: string): Promise<void> {
    await this.#write({
      seq: this.#nextSeq++,
      type: "response",
      request_seq: request.seq,
      success,
      command: request.command,
      ...(message ? { message } : {}),
      ...(body === undefined ? {} : { body }),
    });
  }

  waitForEvent(event: string, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<DapEvent> {
    return new Promise((resolve, reject) => {
      const onEvent = (candidate: DapEvent) => {
        cleanup();
        resolve(candidate);
      };
      const onAbort = () => {
        cleanup();
        reject(signal?.reason instanceof Error ? signal.reason : new Error("DAP wait cancelled"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`DAP event ${event} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off(`event:${event}`, onEvent);
        signal?.removeEventListener("abort", onAbort);
      };
      this.once(`event:${event}`, onEvent);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  close(error = new Error("DAP transport closed")): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.emit("close", error);
  }

  async #write(message: DapMessage | DapResponse): Promise<void> {
    const body = JSON.stringify(message);
    const frame = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
    await new Promise<void>((resolve, reject) => {
      this.writable.write(frame, "utf8", (error) => error ? reject(error) : resolve());
    });
  }

  #consume(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const headerEnd = this.#buffer.indexOf(HEADER_END);
      if (headerEnd < 0) return;
      const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        this.close(new Error("DAP frame is missing Content-Length"));
        return;
      }
      const length = Number(lengthMatch[1]);
      const bodyStart = headerEnd + HEADER_END.length;
      if (this.#buffer.length < bodyStart + length) return;
      const body = this.#buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.#buffer = this.#buffer.subarray(bodyStart + length);
      let message: DapMessage;
      try {
        message = JSON.parse(body) as DapMessage;
      } catch {
        this.close(new Error("DAP frame contains invalid JSON"));
        return;
      }
      this.#dispatch(message);
    }
  }

  #dispatch(message: DapMessage): void {
    if (message.type === "response") {
      const pending = this.#pending.get(message.request_seq);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.request_seq);
      if (!message.success) {
        pending.reject(new Error(message.message || `DAP ${pending.command} failed`));
        return;
      }
      pending.resolve(message);
      return;
    }
    if (message.type === "event") {
      this.emit("event", message);
      this.emit(`event:${message.event}`, message);
      return;
    }
    this.emit("request", message);
    this.emit(`request:${message.command}`, message);
  }
}

export function protocolFromDuplex(stream: Duplex): DapProtocol {
  return new DapProtocol(stream, stream);
}
