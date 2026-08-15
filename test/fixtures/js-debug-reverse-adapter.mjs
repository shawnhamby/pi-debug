import fs from "node:fs";
import net from "node:net";

const [, , portText, mode = "valid", traceFile] = process.argv;
let nextSeq = 100;
let connectionCount = 0;
let rootLaunch;

function writeTrace(role, command) {
  if (traceFile) fs.appendFileSync(traceFile, `${role}:${command}\n`);
}

function frame(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function send(socket, message) {
  socket.write(frame(message));
}

function response(socket, request, success = true, body = {}, message) {
  send(socket, {
    seq: nextSeq++,
    type: "response",
    request_seq: request.seq,
    success,
    command: request.command,
    ...(message ? { message } : {}),
    body,
  });
}

function event(socket, name, body = {}) {
  send(socket, { seq: nextSeq++, type: "event", event: name, body });
}

function consume(socket, role) {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const header = buffer.subarray(0, boundary).toString("ascii");
      const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1]);
      const start = boundary + 4;
      if (!Number.isFinite(length) || buffer.length < start + length) return;
      const message = JSON.parse(buffer.subarray(start, start + length).toString("utf8"));
      buffer = buffer.subarray(start + length);
      handle(socket, role, message);
    }
  });
}

function handle(socket, role, message) {
  if (message.type === "response" && role === "root" && message.request_seq === 900) {
    return;
  }
  if (message.type !== "request") return;
  writeTrace(
    role,
    message.command === "setBreakpoints"
      ? `${message.command}:${JSON.stringify(message.arguments?.source ?? {})}`
      : message.command,
  );
  switch (message.command) {
    case "initialize":
      response(socket, message, true, {
        supportsConfigurationDoneRequest: true,
        supportsTerminateRequest: true,
      });
      queueMicrotask(() => event(socket, "initialized"));
      return;
    case "setBreakpoints":
      response(socket, message, true, {
        breakpoints: (message.arguments?.breakpoints ?? []).map((entry) => ({ verified: true, line: entry.line })),
      });
      return;
    case "configurationDone":
      response(socket, message);
      return;
    case "launch":
      if (role === "root") {
        rootLaunch = message;
        response(socket, message);
        const configuration = {
          type: "pwa-node",
          name: "Pi debug target",
          __pendingTargetId: "owned-target-1",
          ...(mode === "unsafe" ? { program: "/tmp/unowned.js" } : {}),
        };
        queueMicrotask(() => send(socket, {
            seq: 900,
            type: "request",
            command: "startDebugging",
            arguments: { request: "launch", configuration },
          }));
      } else if (mode === "missing") {
        response(socket, message, false, undefined, "Cannot find module: missing-program.js");
      } else {
        response(socket, message);
        queueMicrotask(() => event(socket, "stopped", { reason: "entry", threadId: 1, allThreadsStopped: true }));
      }
      return;
    case "threads":
      response(socket, message, true, { threads: [{ id: 1, name: "main" }] });
      return;
    case "continue":
      response(socket, message);
      queueMicrotask(() => mode === "exit"
        ? event(socket, "exited", { exitCode: 0 })
        : event(socket, "stopped", { reason: "breakpoint", threadId: 1, allThreadsStopped: true }));
      return;
    case "terminate":
    case "disconnect":
      response(socket, message);
      queueMicrotask(() => event(socket, "terminated"));
      return;
    default:
      response(socket, message, false, undefined, `unsupported: ${message.command}`);
  }
}

const server = net.createServer((socket) => {
  const role = connectionCount++ === 0 ? "root" : "target";
  consume(socket, role);
});
server.listen(Number(portText), "127.0.0.1");
