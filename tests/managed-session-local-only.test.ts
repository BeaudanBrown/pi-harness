import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerLocalNavigationGuard } from "../config/agent/extensions/managed-sessions/launch/local-guard.js";
import { createManagedSessionAdapterExtension } from "../config/agent/extensions/managed-sessions/adapter/extension.js";

test("local-only disables even an explicitly rediscovered managed adapter before tool or event registration", () => {
	const api = new Proxy({}, { get() { throw new Error("managed registration reached in local-only mode"); } });
	createManagedSessionAdapterExtension("ordinary_adapter", { PI_HARNESS_LOCAL_ONLY: "1", PI_MANAGED_SESSIONS_SOCKET: "/must-not-connect" })(api as ExtensionAPI);
});

test("native navigation guard cancels bound resume before the SDK opens the file", async t => {
	const root = await mkdtemp(join(tmpdir(), "pi-local-only-")); t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "session.jsonl");
	const text = [JSON.stringify({ type: "session", version: 3, id: "saved", cwd: root }), JSON.stringify({ type: "custom", id: "boundary", parentId: null,
		customType: "managed-session.binding-boundary", data: { version: "1.0.0", sessionId: "saved", creationKey: "saved", concept: "Saved" } })].join("\n") + "\n";
	await writeFile(file, text);
	const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	registerLocalNavigationGuard({ on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { hooks.set(name, handler); } } as ExtensionAPI,
		{ CURRENT_SESSION_VERSION: 3, parseSessionEntries: text => text.trim().split("\n").map(line => JSON.parse(line)) });
	const notices: string[] = [];
	const ctx = { ui: { notify(text: string) { notices.push(text); } }, sessionManager: { getSessionDir: () => root } } as unknown as ExtensionContext;
	assert.deepEqual(await hooks.get("session_before_switch")!({ reason: "resume", targetSessionFile: file }, ctx), { cancel: true });
	assert.match(notices[0], /cannot be resumed/); assert.equal(await readFile(file, "utf8"), text);
	await writeFile(file, JSON.stringify({ type: "session", version: 3, id: "ordinary", cwd: root }) + "\n");
	assert.equal(await hooks.get("session_before_switch")!({ reason: "resume", targetSessionFile: file }, ctx), undefined);
	assert.equal(await hooks.get("session_before_fork")!({}, ctx), undefined);
});
