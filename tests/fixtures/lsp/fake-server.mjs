#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let buffer = Buffer.alloc(0);
const openDocuments = new Set();
const eventsPath = process.env.FAKE_LSP_EVENTS;
const workspaceSymbolDelayMs = Number(process.env.FAKE_LSP_WORKSPACE_SYMBOL_DELAY_MS ?? "0");
const workspaceSymbolFail = process.env.FAKE_LSP_WORKSPACE_SYMBOL_FAIL === "1";
const workspaceSymbolCap = process.env.FAKE_LSP_CAP_WORKSPACE_SYMBOL !== "false";
const requireOpenForHover = process.env.FAKE_LSP_REQUIRE_OPEN_FOR_HOVER === "1";

function record(event) {
  if (!eventsPath) return;
  appendFileSync(eventsPath, `${JSON.stringify({ time: Date.now(), ...event })}\n`);
}

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handle(message) {
  record({ direction: "in", method: message.method, id: message.id, params: message.params });

  if (message.method === "initialize") {
    respond(message.id, {
      capabilities: {
        textDocumentSync: 2,
        hoverProvider: true,
        definitionProvider: true,
        documentSymbolProvider: true,
        workspaceSymbolProvider: workspaceSymbolCap,
      },
    });
    if (process.env.FAKE_LSP_EXIT_AFTER_INITIALIZE === "1") process.exit(0);
    return;
  }

  if (message.method === "shutdown") {
    respond(message.id, null);
    return;
  }

  if (message.method === "exit") {
    process.exit(0);
  }

  if (message.method === "textDocument/didOpen") {
    openDocuments.add(message.params?.textDocument?.uri);
    return;
  }

  if (message.method === "textDocument/didChange") {
    openDocuments.add(message.params?.textDocument?.uri);
    return;
  }

  if (message.method === "textDocument/hover") {
    const uri = message.params?.textDocument?.uri;
    if (requireOpenForHover && !openDocuments.has(uri)) {
      respondError(message.id, -32000, `Document is not open: ${uri}`);
      return;
    }
    respond(message.id, { contents: { kind: "plaintext", value: "fake hover" } });
    return;
  }

  if (message.method === "textDocument/definition") {
    const uri = message.params?.textDocument?.uri;
    respond(message.id, { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } });
    return;
  }

  if (message.method === "textDocument/documentSymbol") {
    respond(message.id, [{ name: "fakeSymbol", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } }]);
    return;
  }

  if (message.method === "workspace/symbol") {
    if (workspaceSymbolDelayMs > 0) await delay(workspaceSymbolDelayMs);
    if (workspaceSymbolFail) {
      respondError(message.id, -32001, "fake workspace symbol failure");
      return;
    }
    const root = process.cwd();
    respond(message.id, [{ name: `fakeWorkspaceSymbol:${process.env.FAKE_LSP_NAME ?? "default"}`, kind: 12, location: { uri: fileURLToPath ? new URL("file://" + root + "/fake.ts").toString() : "file:///fake.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } } }]);
    return;
  }

  if (message.id !== undefined) respond(message.id, null);
}

function parseMessages() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = header.match(/Content-Length: (\d+)/i);
    if (!match) throw new Error(`Missing Content-Length header: ${header}`);
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);
    void handle(JSON.parse(body));
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  parseMessages();
});

record({ direction: "server", method: "started", pid: process.pid });
