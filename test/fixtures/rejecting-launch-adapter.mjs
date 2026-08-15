import fs from "node:fs";
import { spawn } from "node:child_process";

const pidFile = process.argv[2];
let buffer = Buffer.alloc(0);
let nextSeq = 1;

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function respond(request, success, message) {
  send({
    seq: nextSeq++,
    type: "response",
    request_seq: request.seq,
    success,
    command: request.command,
    ...(message ? { message } : {}),
  });
}

function dispatch(request) {
  if (request.command === "initialize") {
    respond(request, true);
    return;
  }
  if (request.command === "launch") {
    const debuggee = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    fs.writeFileSync(pidFile, String(debuggee.pid));
    respond(request, false, "intentional launch rejection");
    setTimeout(() => send({ seq: nextSeq++, type: "event", event: "initialized" }), 25);
    return;
  }
  respond(request, true);
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1]);
    const bodyStart = headerEnd + 4;
    if (!Number.isFinite(length) || buffer.length < bodyStart + length) return;
    const request = JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString("utf8"));
    buffer = buffer.subarray(bodyStart + length);
    dispatch(request);
  }
});
