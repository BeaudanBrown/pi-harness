import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codexFastExtension from "../config/agent/extensions/codex-fast/index.js";

interface Entry {
	type: "custom";
	customType: string;
	data: unknown;
}

function fixture(options: { fastFlag?: boolean; entries?: Entry[]; provider?: string; sessionId?: string } = {}) {
	const entries = [...(options.entries ?? [])];
	const handlers = new Map<string, (...args: any[]) => any>();
	let command: ((args: string, ctx: any) => Promise<void>) | undefined;
	const pi = {
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		getFlag: (name: string) => name === "fast" && options.fastFlag === true,
		on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
		registerCommand: (_name: string, definition: { handler: (args: string, ctx: any) => Promise<void> }) => { command = definition.handler; },
		registerFlag: () => undefined,
	} as unknown as ExtensionAPI;
	codexFastExtension(pi);
	const ctx = {
		hasUI: false,
		model: { provider: options.provider ?? "openai-codex", id: "fixture" },
		sessionManager: {
			getBranch: () => entries,
			getSessionId: () => options.sessionId ?? "session-a",
		},
	};
	return {
		entries,
		start: (reason: "startup" | "reload" | "new" | "resume" | "fork") => handlers.get("session_start")!({ reason }, ctx),
		toggle: () => command!("", ctx),
		request: (payload: Record<string, unknown> = {}) => handlers.get("before_provider_request")!({ payload }, ctx),
	};
}

test("fast mode is persisted in only the active Pi session", async () => {
	const first = fixture();
	first.start("startup");
	assert.equal(first.request({ model: "fixture" }), undefined);

	await first.toggle();
	assert.deepEqual(first.entries, [{
		type: "custom",
		customType: "codex-fast.state",
		data: { version: 1, sessionId: "session-a", enabled: true },
	}]);
	assert.equal(first.request({ model: "fixture" }).service_tier, "priority");

	const resumed = fixture({ entries: first.entries });
	resumed.start("resume");
	assert.equal(resumed.request({}).service_tier, "priority");

	const unrelated = fixture({ sessionId: "session-b" });
	unrelated.start("startup");
	assert.equal(unrelated.request({}), undefined);

	const fork = fixture({ entries: first.entries, sessionId: "session-fork" });
	fork.start("fork");
	assert.equal(fork.request({}), undefined);
	fork.start("reload");
	assert.equal(fork.request({}), undefined);

	await resumed.toggle();
	const disabledResume = fixture({ entries: resumed.entries });
	disabledResume.start("resume");
	assert.equal(disabledResume.request({}), undefined);
});

test("--fast applies only to the initial session and records that session state", () => {
	const initial = fixture({ fastFlag: true });
	initial.start("startup");
	assert.equal(initial.request({}).service_tier, "priority");
	assert.deepEqual(initial.entries.at(-1)?.data, { version: 1, sessionId: "session-a", enabled: true });

	const replacement = fixture({ fastFlag: true });
	replacement.start("new");
	assert.equal(replacement.request({}), undefined);
	assert.deepEqual(replacement.entries, []);
});

test("fast mode remains provider-specific and does not override an explicit service tier", async () => {
	const anthropic = fixture({ provider: "anthropic" });
	anthropic.start("startup");
	await anthropic.toggle();
	assert.equal(anthropic.request({}), undefined);

	const openai = fixture();
	openai.start("startup");
	await openai.toggle();
	assert.equal(openai.request({ service_tier: "default" }), undefined);
});
