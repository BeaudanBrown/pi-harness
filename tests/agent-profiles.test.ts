import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentProfilesExtension from "../config/agent/extensions/agent-profiles/index.js";
import {
	AGENT_PROFILE_NAMES,
	activeToolsForProfile,
	loadAgentProfileDocument,
	parseAgentProfileDocument,
	resolveAgentProfile,
	withProjectWorkerOptIn,
} from "../config/agent/extensions/agent-profiles/core.js";

const mutationTools = [
	"edit", "write", "bash", "github_issue_mutate", "github_issue_relationship", "github_issue_migration", "github_issue_plan",
];
const orchestrationTools = ["review_agents", "run_worker", "remote_checkpoint", "aloop_launch_worker"];

test("the declarative registry contains exactly the supported personas", () => {
	const document = loadAgentProfileDocument();
	assert.deepEqual(Object.keys(document.profiles).sort(), [...AGENT_PROFILE_NAMES].sort());
	for (const name of AGENT_PROFILE_NAMES) assert.equal(resolveAgentProfile(name, document).name, name);
});

test("normal and inherited profiles advertise no experimental resources", () => {
	for (const name of AGENT_PROFILE_NAMES.filter((name) => name !== "pi-local")) {
		const profile = resolveAgentProfile(name);
		for (const resources of [profile.extensions, profile.skills, profile.prompts]) {
			assert.equal(resources.some((name) => /^(pi-r|agentgraph)/.test(name)), false);
		}
	}
});

test("narrow worker profiles enforce explicit capability allowlists", () => {
	const review = resolveAgentProfile("review-worker");
	const diagnostic = resolveAgentProfile("diagnostic-worker");
	for (const profile of [review, diagnostic]) {
		assert.equal(profile.contextFiles, false);
		assert.equal(profile.toolPolicy, "allowlist");
		assert.deepEqual(activeToolsForProfile(profile, [...profile.tools, ...mutationTools, ...orchestrationTools]), ["read", "grep", "find", "ls"]);
	}
	const patch = resolveAgentProfile("aloop-patch");
	assert.ok(patch.tools.includes("edit") && patch.tools.includes("lsp_diagnostics") && patch.tools.includes("run_worker"));
	assert.ok(patch.tools.includes("aloop_submit_patch_result"));
	assert.equal(patch.tools.includes("review_agents"), false);
	assert.equal(patch.tools.some((tool) => tool.startsWith("github_")), false);
	assert.equal(patch.tools.some((tool) => tool.startsWith("remote_")), false);
});

test("implementation, local, and ordinary engineering preserve their role boundaries", () => {
	const implementation = resolveAgentProfile("aloop-implementation");
	assert.ok(implementation.tools.includes("review_agents"));
	assert.ok(implementation.tools.includes("aloop_issue_context"));
	assert.ok(implementation.tools.includes("aloop_worker_feedback"));
	assert.ok(implementation.tools.includes("aloop_submit_result"));
	assert.deepEqual(implementation.tools.filter((tool) => tool.startsWith("github_")), ["github_issue_inspect", "github_issue_graph"]);
	assert.equal(implementation.tools.includes("github_issue_mutate"), false);
	assert.equal(implementation.tools.includes("remote_checkpoint"), false);
	const projectEnabled = withProjectWorkerOptIn(implementation, { extensions: [".pi/worker-extension.ts"], tools: ["project_lookup"] });
	assert.ok(projectEnabled.extensions.includes(".pi/worker-extension.ts"));
	assert.ok(projectEnabled.tools.includes("project_lookup"));
	assert.throws(() => withProjectWorkerOptIn(implementation, { tools: ["github_issue_mutate"] }), /reserved/);

	const local = resolveAgentProfile("pi-local");
	assert.equal(local.contextFiles, false);
	assert.throws(() => withProjectWorkerOptIn(local, { tools: ["project_lookup"] }), /does not permit/);
	assert.deepEqual(local.extensions, ["pi-r", "agent-profiles"]);
	assert.deepEqual(local.tools, ["read", "bash", "edit", "write", "grep", "find", "ls"]);

	const full = resolveAgentProfile("engineering-full");
	assert.equal(full.toolPolicy, "extension-defaults");
	for (const extension of ["web-search", "github-issues", "aloop", "diagram-tools", "worker-runner", "review-agents", "nix-runtime", "lsp", "matrix-bridge"]) {
		assert.ok(full.extensions.includes(extension), `engineering retains ${extension}`);
	}
	assert.deepEqual(full.skills, ["harness", "matt-pocock"]);
	assert.deepEqual(full.prompts, ["harness"]);
	assert.deepEqual(full.inactiveTools, []);
});

test("profile extension applies the selected allowlist at session start", () => {
	const previous = process.env.PI_HARNESS_AGENT_PROFILE;
	process.env.PI_HARNESS_AGENT_PROFILE = "review-worker";
	try {
		let active = ["read", "bash", "edit", "review_agents"];
		let start: (() => void) | undefined;
		let beforeStart: ((event: { systemPrompt: string }) => { systemPrompt: string }) | undefined;
		const pi = {
			getActiveTools: () => active,
			setActiveTools: (tools: string[]) => { active = tools; },
			on: (event: string, handler: any) => {
				if (event === "session_start") start = handler;
				if (event === "before_agent_start") beforeStart = handler;
			},
		} as unknown as ExtensionAPI;
		agentProfilesExtension(pi);
		assert.ok(start);
		start!();
		assert.deepEqual(active, ["read", "grep", "find", "ls"]);
		assert.match(beforeStart!({ systemPrompt: "base" }).systemPrompt, /base[\s\S]*senior code-review agent/);
	} finally {
		if (previous === undefined) delete process.env.PI_HARNESS_AGENT_PROFILE;
		else process.env.PI_HARNESS_AGENT_PROFILE = previous;
	}
});

test("removed managed personas fail closed rather than selecting a fallback runtime", () => {
	const previous = process.env.PI_HARNESS_AGENT_PROFILE;
	try {
		for (const name of ["managed-project", "managed-coordinator"]) {
			process.env.PI_HARNESS_AGENT_PROFILE = name;
			assert.throws(() => agentProfilesExtension({} as ExtensionAPI), /Unknown agent profile/);
		}
	} finally {
		if (previous === undefined) delete process.env.PI_HARNESS_AGENT_PROFILE;
		else process.env.PI_HARNESS_AGENT_PROFILE = previous;
	}
});

test("malformed or incomplete profile documents fail closed", () => {
	assert.throws(() => parseAgentProfileDocument({ version: 1, profiles: {}, variants: {} }), /malformed/);
	assert.throws(() => resolveAgentProfile("unknown"), /Unknown agent profile/);
});
