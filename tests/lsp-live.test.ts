import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

interface JsonRpcMessage {
	jsonrpc: "2.0";
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

export interface FakeLspEvent {
	direction: string;
	method: string;
	id?: number;
	params?: any;
}

const repoRoot = process.cwd();
const fakeServerPath = join(repoRoot, "tests/fixtures/lsp/fake-server.mjs");

class JsonRpcClient {
	private nextId = 1;
	private buffer = Buffer.alloc(0);
	private pending = new Map<number, { resolve: (value: JsonRpcMessage) => void; reject: (error: Error) => void }>();

	constructor(private child: ChildProcessWithoutNullStreams) {
		child.stdout.on("data", (chunk: Buffer) => {
			this.buffer = Buffer.concat([this.buffer, chunk]);
			this.parseMessages();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			process.stderr.write(chunk);
		});
		child.on("exit", (code) => {
			for (const waiter of this.pending.values()) waiter.reject(new Error(`fake LSP exited with code ${code}`));
			this.pending.clear();
		});
	}

	notify(method: string, params?: unknown): void {
		this.send({ jsonrpc: "2.0", method, params });
	}

	request(method: string, params?: unknown): Promise<JsonRpcMessage> {
		const id = this.nextId++;
		this.send({ jsonrpc: "2.0", id, method, params });
		return new Promise((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for ${method}`));
			}, 2_000);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolvePromise(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
		});
	}

	private send(message: JsonRpcMessage): void {
		const body = JSON.stringify(message);
		this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
	}

	private parseMessages(): void {
		while (true) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;
			const header = this.buffer.subarray(0, headerEnd).toString("ascii");
			const match = header.match(/Content-Length: (\d+)/i);
			assert.ok(match, `missing Content-Length header: ${header}`);
			const length = Number(match[1]);
			const bodyStart = headerEnd + 4;
			if (this.buffer.length < bodyStart + length) return;
			const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
			this.buffer = this.buffer.subarray(bodyStart + length);
			const message = JSON.parse(body) as JsonRpcMessage;
			if (message.id !== undefined) {
				const waiter = this.pending.get(message.id);
				if (waiter) {
					this.pending.delete(message.id);
					waiter.resolve(message);
				}
			}
		}
	}
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "pi-lsp-live-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

export async function readFakeEvents(path: string): Promise<FakeLspEvent[]> {
	const text = await readFile(path, "utf8").catch(() => "");
	return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line) as FakeLspEvent) : [];
}

test("fake LSP server records basic protocol events", async () => {
	await withTempDir(async (dir) => {
		const eventsPath = join(dir, "events.jsonl");
		const child = spawn(process.execPath, [fakeServerPath], {
			cwd: dir,
			env: { ...process.env, FAKE_LSP_EVENTS: eventsPath, FAKE_LSP_REQUIRE_OPEN_FOR_HOVER: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const client = new JsonRpcClient(child);
		try {
			const uri = "file:///tmp/example.ts";
			const init = await client.request("initialize", { capabilities: {}, rootUri: `file://${dir}` });
			assert.equal((init.result as any).capabilities.hoverProvider, true);
			client.notify("initialized", {});
			client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 1, text: "const value = 1;" } });
			const hover = await client.request("textDocument/hover", { textDocument: { uri }, position: { line: 0, character: 6 } });
			assert.equal((hover.result as any).contents.value, "fake hover");
		} finally {
			child.kill();
		}

		const events = await readFakeEvents(eventsPath);
		assert.ok(events.some((event) => event.method === "initialize"));
		assert.ok(events.some((event) => event.method === "textDocument/didOpen"));
		assert.ok(events.some((event) => event.method === "textDocument/hover"));
	});
});

export async function createFixtureFile(root: string, relativePath: string, content: string): Promise<string> {
	const path = join(root, relativePath);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
	return path;
}
