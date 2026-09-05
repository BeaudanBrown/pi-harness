import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
const execFileAsync = promisify(execFile);

async function compileExtensionModule(tempRoot: string, entryPoint: string): Promise<string> {
	const extensionRoot = process.env.PI_LSP_EXTENSION ?? "";
	assert.ok(extensionRoot, "PI_LSP_EXTENSION must point at the packaged pi-lsp-extension root");
	const outDir = join(tempRoot, "compiled-extension");
	try {
		await execFileAsync("tsc", [
			"--outDir", outDir,
			"--rootDir", join(extensionRoot, "src"),
			"--module", "NodeNext",
			"--moduleResolution", "NodeNext",
			"--target", "ES2022",
			"--skipLibCheck",
			"--types", "node",
			"--typeRoots", join(repoRoot, ".pi-types/node_modules/@types"),
			"--noEmitOnError", "false",
			join(extensionRoot, "src", entryPoint),
		], { cwd: repoRoot });
	} catch (error: any) {
		// The packaged extension intentionally has no local dev type closure, but tsc
		// still emits usable JavaScript for the modules under test.
		if (!error?.stdout && !error?.stderr) throw error;
	}
	const nodeModules = join(outDir, "node_modules");
	await mkdir(nodeModules, { recursive: true });
	for (const entry of await readdir(join(extensionRoot, "node_modules"))) {
		if (entry === ".package-lock.json") continue;
		await symlink(join(extensionRoot, "node_modules", entry), join(nodeModules, entry)).catch(() => undefined);
	}
	const sdkScope = join(repoRoot, ".pi-types/node_modules/@earendil-works");
	const compiledScope = join(nodeModules, "@earendil-works");
	await mkdir(compiledScope, { recursive: true });
	for (const entry of await readdir(sdkScope)) {
		if (["pi-coding-agent", "pi-tui"].includes(entry)) continue;
		await symlink(join(sdkScope, entry), join(compiledScope, entry)).catch(() => undefined);
	}
	const codingAgentShim = join(compiledScope, "pi-coding-agent");
	await mkdir(codingAgentShim, { recursive: true });
	await writeFile(join(codingAgentShim, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
	await writeFile(join(codingAgentShim, "index.js"), `
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 51200;
export function truncateHead(text) { return { content: text, truncated: false }; }
`);
	const tuiShim = join(compiledScope, "pi-tui");
	await mkdir(tuiShim, { recursive: true });
	await writeFile(join(tuiShim, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
	await writeFile(join(tuiShim, "index.js"), "export class Text {}\n");
	await symlink(join(repoRoot, ".pi-types/node_modules/@types"), join(nodeModules, "@types")).catch(() => undefined);
	return join(outDir, entryPoint.replace(/\.ts$/, ".js"));
}


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

test("SCSS and LESS use dedicated language IDs backed by the CSS server", async () => {
	const extensionRoot = process.env.PI_LSP_EXTENSION ?? "";
	assert.ok(extensionRoot, "PI_LSP_EXTENSION must point at the packaged pi-lsp-extension root");
	const languageMap = await readFile(join(extensionRoot, "src/shared/language-map.ts"), "utf8");
	const managerSource = await readFile(join(extensionRoot, "src/lsp-manager.ts"), "utf8");
	assert.match(languageMap, /"\.scss": "scss"/);
	assert.match(languageMap, /"\.less": "less"/);
	assert.match(managerSource, /scss: \{ command: "vscode-css-language-server"/);
	assert.match(managerSource, /less: \{ command: "vscode-css-language-server"/);
});

test("Haskell files use the project-local HLS wrapper by default", async () => {
	const extensionRoot = process.env.PI_LSP_EXTENSION ?? "";
	assert.ok(extensionRoot, "PI_LSP_EXTENSION must point at the packaged pi-lsp-extension root");
	const languageMap = await readFile(join(extensionRoot, "src/shared/language-map.ts"), "utf8");
	const managerSource = await readFile(join(extensionRoot, "src/lsp-manager.ts"), "utf8");
	assert.match(languageMap, /"\.hs": "haskell"/);
	assert.match(languageMap, /"\.lhs": "haskell"/);
	assert.match(managerSource, /haskell: \{ command: "haskell-language-server-wrapper", args: \["--lsp"\] \}/);
});

test("Typebox-backed tool modules load against the packaged extension dependencies", async () => {
	await withTempDir(async (dir) => {
		const symbolsModule = await compileExtensionModule(dir, "tools/symbols.ts");
		const imported = await import(`file://${symbolsModule}`) as { createSymbolsTool?: unknown };
		assert.equal(typeof imported.createSymbolsTool, "function");
	});
});

test("workspace symbols are capability-aware and timeout-bounded", async () => {
	const extensionRoot = process.env.PI_LSP_EXTENSION ?? "";
	assert.ok(extensionRoot, "PI_LSP_EXTENSION must point at the packaged pi-lsp-extension root");
	const symbolsSource = await readFile(join(extensionRoot, "src/tools/symbols.ts"), "utf8");
	assert.match(symbolsSource, /WORKSPACE_SYMBOL_TIMEOUT_MS/);
	assert.match(symbolsSource, /Promise\.all\(queryableStatuses\.map/);
	assert.match(symbolsSource, /workspaceSymbols !== false/);
	assert.match(symbolsSource, /Skipped unsupported servers/);
});

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5_000): Promise<T> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const value = fn();
		if (value !== undefined) return value;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
	}
	throw new Error("Timed out waiting for condition");
}

test("LspManager status reports startup errors and setup hints", async () => {
	await withTempDir(async (dir) => {
		const managerModule = await compileExtensionModule(dir, "lsp-manager.ts");
		const { LspManager } = await import(`file://${managerModule}`) as { LspManager: new (...args: any[]) => any };
		const workspace = {
			workspaceRoot: dir,
			stateDir: null,
			ensureReady: async () => true,
			getWorkspaceFolders: () => [],
			getStatusText: () => "test workspace",
		};
		const manager = new LspManager(dir, {
			typescript: { command: "definitely-missing-pi-lsp-server", args: [] },
		}, undefined, "test-session", workspace);

		assert.equal(await manager.getClientForLanguage("typescript"), null);
		const failedStatus = await waitFor(() => {
			const status = manager.getStatus().find((entry: any) => entry.languageId === "typescript");
			return status?.lastError ? status : undefined;
		});
		assert.match(failedStatus.lastError, /definitely-missing-pi-lsp-server|ENOENT|not found/i);
		assert.match(failedStatus.setupHint, /PATH|dev shell|\.pi-lsp\.json/);
		assert.match(manager.getUnavailableReason("example.ts"), /startup failure/);
	});
});

async function createLiveManager(dir: string, configs: Record<string, { command: string; args: string[]; env?: Record<string, string> }>): Promise<any> {
	const managerModule = await compileExtensionModule(dir, "lsp-manager.ts");
	const { LspManager } = await import(`file://${managerModule}`) as { LspManager: new (...args: any[]) => any };
	const workspace = {
		workspaceRoot: dir,
		stateDir: null,
		ensureReady: async () => true,
		getWorkspaceFolders: () => [{ uri: new URL(`file://${dir}`).toString(), name: "fixture" }],
		getStatusText: () => "test workspace",
		shutdown: () => undefined,
	};
	return new LspManager(dir, configs, undefined, "test-session", workspace);
}

async function startLiveClient(manager: any, languageId: string): Promise<any> {
	await manager.getClientForLanguage(languageId);
	return waitFor(() => manager.getRunningClient(languageId) ?? undefined, 15_000);
}

test("LSP initialized crash loops exhaust retries, resist demand bypass, and notify once", async () => {
	await withTempDir(async (dir) => {
		const manager = await createLiveManager(dir, { typescript: { command: process.execPath, args: [fakeServerPath], env: { FAKE_LSP_CRASH_AFTER_MS: "100" } } });
		manager.constructor.INITIAL_BACKOFF_MS = 10;
		const errors: string[] = [];
		manager._callbacks.onServerError = (_language: string, message: string) => errors.push(message);
		try {
			await manager.getClientForLanguage("typescript");
			await waitFor(() => manager._restartExhausted.has("typescript") ? true : undefined, 10_000);
			assert.equal(manager._restartAttempts.get("typescript"), 3);
			for (let i = 0; i < 10; i++) { manager.handleUnexpectedExit("typescript", 69); await manager.getClientForLanguage("typescript"); manager.startEagerly(["typescript"]); }
			assert.equal(errors.filter((message) => message.includes("auto-restart disabled")).length, 1);
			assert.equal(manager.startingServers.size, 0);
			assert.equal(manager._restartTimers.size, 0);
		} finally { await manager.shutdownAll(); }
		assert.equal(manager._healthTimers.size, 0);
	});
});

test("LSP counters reset only after stable health and shutdown clears queued timers", async () => {
	await withTempDir(async (dir) => {
		const manager = await createLiveManager(dir, { typescript: { command: process.execPath, args: [fakeServerPath] } });
		manager.constructor.STABLE_HEALTH_MS = 200;
		manager._restartAttempts.set("typescript", 2);
		try {
			await startLiveClient(manager, "typescript");
			assert.equal(manager._restartAttempts.get("typescript"), 2);
			await waitFor(() => !manager._restartAttempts.has("typescript") ? true : undefined);
			await manager.getRunningClient("typescript").shutdown();
			manager.handleUnexpectedExit("typescript", 69);
			assert.equal(manager._restartTimers.size, 1);
		} finally { await manager.shutdownAll(); }
		assert.equal(manager._restartTimers.size, 0);
		assert.equal(manager._healthTimers.size, 0);
		assert.equal(await manager.getClientForLanguage("typescript"), null);
	});
});

test("real TypeScript fallback server starts and answers document symbols", async () => {
	await withTempDir(async (dir) => {
		await createFixtureFile(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true }, include: ["src/**/*.ts"] }));
		const sourcePath = await createFixtureFile(dir, "src/index.ts", "export function greet(name: string): string { return `hello ${name}`; }\n");
		const manager = await createLiveManager(dir, { typescript: { command: "typescript-language-server", args: ["--stdio"] } });
		const client = await startLiveClient(manager, "typescript");
		const uri = new URL(`file://${sourcePath}`).toString();
		client.didOpen(uri, "typescript", 1, await readFile(sourcePath, "utf8"));
		const result = await client.sendRequest("textDocument/documentSymbol", { textDocument: { uri } });
		assert.ok(Array.isArray(result));
		assert.equal(manager.getStatus().find((entry: any) => entry.languageId === "typescript")?.running, true);
		await manager.shutdownAll();
	});
});

test("real nil fallback server starts and reports status", async () => {
	await withTempDir(async (dir) => {
		const sourcePath = await createFixtureFile(dir, "sample.nix", "{ lib ? null }: { value = 1; }\n");
		const manager = await createLiveManager(dir, { nix: { command: "nil", args: [] } });
		const client = await startLiveClient(manager, "nix");
		const uri = new URL(`file://${sourcePath}`).toString();
		client.didOpen(uri, "nix", 1, await readFile(sourcePath, "utf8"));
		const hover = await client.sendRequest("textDocument/hover", { textDocument: { uri }, position: { line: 0, character: 2 } }).catch((error: Error) => error);
		assert.ok(hover);
		const status = manager.getStatus().find((entry: any) => entry.languageId === "nix");
		assert.equal(status?.running, true);
		assert.equal(status?.command, "nil");
		await manager.shutdownAll();
	});
});

test("FileSync opens once, refreshes changed content, and keys daemon clients by sync identity", async () => {
	await withTempDir(async (dir) => {
		const filePath = await createFixtureFile(dir, "src/example.ts", "export const value = 1;\n");
		const fileSyncModule = await compileExtensionModule(dir, "file-sync.ts");
		const { FileSync } = await import(`file://${fileSyncModule}`) as { FileSync: new (manager: any) => any };

		const calls: Array<{ method: string; identity: string; version?: number; text?: string }> = [];
		const makeClient = (identity: string) => ({
			syncIdentity: identity,
			languageId: "typescript",
			rootDir: dir,
			didOpen: (_uri: string, _languageId: string, version: number, text: string) => calls.push({ method: "didOpen", identity, version, text }),
			didChange: (_uri: string, version: number, text: string) => calls.push({ method: "didChange", identity, version, text }),
			didClose: () => calls.push({ method: "didClose", identity }),
		});
		let runningClient = makeClient("daemon:typescript:/tmp/fake.sock");
		const manager = {
			resolvePath: (path: string) => path.startsWith("/") ? path : join(dir, path),
			getFileUri: (path: string) => new URL(`file://${path}`).toString(),
			getLanguageId: () => "typescript",
			getRunningClient: () => runningClient,
		};
		const sync = new FileSync(manager);

		await sync.ensureFileOpen(filePath, runningClient);
		await sync.ensureFileOpen(filePath, runningClient);
		await writeFile(filePath, "export const value = 2;\n");
		await sync.ensureFileOpen(filePath, runningClient);
		runningClient = makeClient("daemon:typescript:/tmp/fake.sock");
		await sync.ensureFileOpen(filePath, runningClient);
		runningClient = makeClient("daemon:typescript:/tmp/other.sock");
		await sync.ensureFileOpen(filePath, runningClient);

		assert.deepEqual(calls.map((call) => [call.method, call.identity, call.version]), [
			["didOpen", "daemon:typescript:/tmp/fake.sock", 1],
			["didChange", "daemon:typescript:/tmp/fake.sock", 2],
			["didOpen", "daemon:typescript:/tmp/other.sock", 3],
		]);
		assert.equal(calls[1]?.text, "export const value = 2;\n");
	});
});
