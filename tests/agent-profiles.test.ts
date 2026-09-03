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

test("implementation, coordinator, local, and managed variants preserve their role boundaries", () => {
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

	const coordinator = resolveAgentProfile("managed-coordinator");
	assert.equal(coordinator.builtinTools, false);
	assert.ok(coordinator.tools.length > 0 && coordinator.tools.every((tool) => tool.startsWith("remote_")));
	assert.equal(coordinator.tools.includes("remote_checkpoint"), false);
	assert.equal(coordinator.extensions.includes("lsp"), false);

	const local = resolveAgentProfile("pi-local");
	assert.equal(local.contextFiles, false);
	assert.throws(() => withProjectWorkerOptIn(local, { tools: ["project_lookup"] }), /does not permit/);
	assert.deepEqual(local.extensions, ["pi-r", "agent-profiles"]);

	const full = resolveAgentProfile("engineering-full");
	const managed = resolveAgentProfile("managed-project");
	assert.equal(managed.toolPolicy, full.toolPolicy);
	assert.ok(full.extensions.includes("lsp"));
	assert.deepEqual(managed.extensions, full.extensions.filter((name) => !["pi-r", "agentgraph", "tmux-cursor-focus", "sesh"].includes(name)));
	for (const extension of ["web-search", "github-issues", "aloop", "diagram-tools", "worker-runner", "review-agents", "nix-runtime", "lsp"]) {
		assert.ok(managed.extensions.includes(extension), `managed project retains ${extension}`);
	}
	assert.deepEqual(managed.skills, ["harness", "matt-pocock"]);
	assert.deepEqual(managed.prompts, ["harness"]);
	assert.deepEqual(managed.inactiveTools, ["diagram_show"]);
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

test("managed project activation keeps engineering tools while removing the local viewer", () => {
	const previous = process.env.PI_HARNESS_AGENT_PROFILE;
	process.env.PI_HARNESS_AGENT_PROFILE = "managed-project";
	try {
		let active = ["read", "web_search", "github_issue_mutate", "run_worker", "review_agents", "diagram_render", "diagram_show", "architecture_query"];
		let start: (() => void) | undefined;
		const pi = {
			getActiveTools: () => active,
			setActiveTools: (tools: string[]) => { active = tools; },
			on: (event: string, handler: any) => { if (event === "session_start") start = handler; },
		} as unknown as ExtensionAPI;
		agentProfilesExtension(pi);
		start!();
		assert.deepEqual(active, ["read", "web_search", "github_issue_mutate", "run_worker", "review_agents", "diagram_render", "architecture_query"]);
	} finally {
		if (previous === undefined) delete process.env.PI_HARNESS_AGENT_PROFILE;
		else process.env.PI_HARNESS_AGENT_PROFILE = previous;
	}
});

test("malformed or incomplete profile documents fail closed", () => {
	assert.throws(() => parseAgentProfileDocument({ version: 1, profiles: {}, variants: {} }), /malformed/);
	assert.throws(() => resolveAgentProfile("unknown"), /Unknown agent profile/);
});
