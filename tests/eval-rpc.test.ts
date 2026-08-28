import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { PiRpcEngine, RpcEngineError } from "../eval/rpc/engine.js";

const fakeRpc = path.resolve("tests/fixtures/eval-rpc/fake-rpc.mjs");

function engineFor(mode: string, overrides: Record<string, unknown> = {}): PiRpcEngine {
	return new PiRpcEngine({
		command: process.execPath,
		args: [fakeRpc],
		env: { FAKE_RPC_MODE: mode },
		commandTimeoutMs: 1_000,
		promptTimeoutMs: 2_000,
		runTimeoutMs: 5_000,
		shutdownGraceMs: 100,
		...overrides,
	});
}

async function waitForProcessExit(pid: number): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`process ${pid} remained alive`);
}

test("command deadline aborts the run and cleans its process tree", async () => {
	const engine = engineFor("command-timeout", { commandTimeoutMs: 70, promptTimeoutMs: 1_000 });
	await engine.start();
	let grandchildPid = 0;
	await assert.rejects(
		engine.promptAndWait("Stall a fabricated state command."),
		(error: unknown) => {
			assert.ok(error instanceof RpcEngineError);
			assert.match(error.message, /RPC command get_state timed out/);
			grandchildPid = Number(error.diagnostics.stderr.match(/grandchild:(\d+)/)?.[1]);
			assert.equal(Number.isInteger(grandchildPid), true);
			assert.equal(error.diagnostics.records.some((record) => record.type === "agent_settled"), true);
			return true;
		},
	);
	assert.equal(engine.getDiagnostics().commands.some((command) => command.type === "abort"), true);
	await engine.stop();
	await waitForProcessExit(grandchildPid);
});

test("prompt timeout terminates the complete RPC process tree", async () => {
	const engine = engineFor("timeout", { promptTimeoutMs: 80, runTimeoutMs: 2_000 });
	await engine.start();
	let grandchildPid = 0;
	await assert.rejects(
		engine.promptAndWait("Trigger a bounded synthetic timeout."),
		(error: unknown) => {
			assert.ok(error instanceof RpcEngineError);
			assert.match(error.message, /Prompt did not settle/);
			grandchildPid = Number(error.diagnostics.stderr.match(/grandchild:(\d+)/)?.[1]);
			assert.equal(Number.isInteger(grandchildPid), true);
			assert.equal(error.diagnostics.records.some((record) => record.type === "agent_start"), true);
			return true;
		},
	);
	assert.equal(engine.getDiagnostics().commands.some((command) => command.type === "abort"), true);
	await engine.stop();
	await waitForProcessExit(grandchildPid);
});

test("abort signal cancels and terminates a running prompt", async () => {
	const engine = engineFor("timeout", { promptTimeoutMs: 2_000, runTimeoutMs: 3_000 });
	await engine.start();
	const abort = new AbortController();
	setTimeout(() => abort.abort(), 40);
	try {
		await assert.rejects(engine.promptAndWait("Cancel fabricated work.", abort.signal), /Prompt cancelled/);
	} finally {
		await engine.stop();
	}
});

test("whole-run deadline bounds an unsettled RPC process", async () => {
	const engine = engineFor("timeout", { promptTimeoutMs: 2_000, runTimeoutMs: 70 });
	await engine.start();
	try {
		await assert.rejects(engine.promptAndWait("Exceed the synthetic whole-run deadline."), /Whole RPC run timed out/);
	} finally {
		await engine.stop();
	}
});

test("unterminated JSON at EOF is rejected as malformed strict JSONL", async () => {
	const engine = engineFor("unterminated");
	await engine.start();
	try {
		await assert.rejects(
			engine.promptAndWait("Trigger a fabricated unterminated record."),
			(error: unknown) => {
				assert.ok(error instanceof RpcEngineError);
				assert.match(error.message, /Unterminated RPC JSONL record at EOF/);
				assert.equal(error.diagnostics.malformedLine, '{"type":"unterminated_event"}');
				return true;
			},
		);
	} finally {
		await engine.stop();
	}
});

test("rejected prompt fails immediately without waiting for settlement", async () => {
	const engine = engineFor("prompt-rejected", { promptTimeoutMs: 2_000 });
	await engine.start();
	const startedAt = Date.now();
	try {
		await assert.rejects(engine.promptAndWait("Reject fabricated work."), /synthetic prompt rejected/);
		assert.equal(Date.now() - startedAt < 500, true);
		assert.equal((await engine.request({ type: "get_state" })).success, true);
	} finally {
		await engine.stop();
	}
});

test("malformed output fails with stderr and partial traces retained", async () => {
	const engine = engineFor("malformed");
	await engine.start();
	try {
		await assert.rejects(
			engine.promptAndWait("Trigger a fabricated malformed record."),
			(error: unknown) => {
				assert.ok(error instanceof RpcEngineError);
				assert.match(error.message, /Malformed RPC JSONL record/);
				assert.equal(error.diagnostics.malformedLine, "{not-json}");
				assert.match(error.diagnostics.stderr, /synthetic stderr/);
				assert.equal(error.diagnostics.records.some((record) => record.type === "agent_start"), true);
				return true;
			},
		);
	} finally {
		await engine.stop();
	}
});

test("process crash rejects pending prompt with exit and stderr diagnostics", async () => {
	const engine = engineFor("crash");
	await engine.start();
	try {
		await assert.rejects(
			engine.promptAndWait("Trigger a fabricated crash."),
			(error: unknown) => {
				assert.ok(error instanceof RpcEngineError);
				assert.match(error.message, /exited before shutdown/);
				assert.match(error.diagnostics.stderr, /synthetic crash diagnostics/);
				assert.equal(error.diagnostics.exit?.code, 23);
				return true;
			},
		);
	} finally {
		await engine.stop();
	}
});

test("unexpected parent crash still cleans up hanging descendants", async () => {
	const engine = engineFor("crash-child");
	await engine.start();
	let grandchildPid = 0;
	await assert.rejects(
		engine.promptAndWait("Crash a fabricated process tree."),
		(error: unknown) => {
			assert.ok(error instanceof RpcEngineError);
			grandchildPid = Number(error.diagnostics.stderr.match(/grandchild:(\d+)/)?.[1]);
			assert.equal(Number.isInteger(grandchildPid), true);
			return true;
		},
	);
	await engine.stop();
	await waitForProcessExit(grandchildPid);
});

test("truncated completion remains observable until agent_settled", async () => {
	const engine = engineFor("truncated");
	await engine.start();
	try {
		const run = await engine.promptAndWait("Produce a fabricated truncated completion.");
		assert.equal(run.events.some((event) =>
			event.type === "message_update"
			&& (event.assistantMessageEvent as { reason?: string } | undefined)?.reason === "length"), true);
		assert.equal(run.events.at(-1)?.type, "agent_settled");
	} finally {
		await engine.stop();
	}
});

test("strict LF framing preserves Unicode separators across split UTF-8 chunks", async () => {
	const engine = engineFor("split-unicode");
	await engine.start();
	try {
		const run = await engine.promptAndWait("Preserve synthetic Unicode text.");
		assert.deepEqual(run.events.find((event) => event.type === "unicode_event"), {
			type: "unicode_event",
			text: "alpha\u2028beta\u2029gamma",
		});
		assert.equal(engine.getDiagnostics().stdoutLines.some((line) => line === "beta"), false);
	} finally {
		await engine.stop();
	}
});

test("retry and compaction events do not settle on agent_end", async () => {
	const engine = engineFor("retry-compaction");
	await engine.start();
	try {
		const run = await engine.promptAndWait("Exercise synthetic retry lifecycle.");
		assert.deepEqual(run.events.map((event) => event.type), [
			"agent_start",
			"agent_end",
			"auto_retry_start",
			"compaction_start",
			"compaction_end",
			"auto_retry_end",
			"agent_end",
			"agent_settled",
		]);
	} finally {
		await engine.stop();
	}
});

test("known fire-and-forget extension UI methods remain nonblocking", async () => {
	const engine = engineFor("fire-and-forget-ui");
	await engine.start();
	try {
		const run = await engine.promptAndWait("Emit synthetic nonblocking UI updates.");
		assert.equal(run.settled, true);
		assert.equal(run.events.filter((event) => event.type === "extension_ui_request").length, 4);
		assert.equal(engine.getDiagnostics().commands.some((command) => command.type === "abort"), false);
	} finally {
		await engine.stop();
	}
});

test("unknown extension UI method aborts instead of leaving a dialog pending", async () => {
	const engine = engineFor("unknown-ui");
	await engine.start();
	try {
		await assert.rejects(
			engine.promptAndWait("Emit an unknown synthetic dialog."),
			/Unsupported extension UI request method: custom-dialog/,
		);
		assert.equal(engine.getDiagnostics().commands.some((command) => command.type === "abort"), true);
	} finally {
		await engine.stop();
	}
});

test("v3 scenarios retain the compatible observable extension UI policy", () => {
	assert.doesNotThrow(() => engineFor("ui", {
		uiPolicy: { schemaVersion: "3.0.0", dialogs: [] },
	}));
});

test("v1 extension UI policy fails with an explicit migration error", () => {
	assert.throws(() => engineFor("ui", {
		uiPolicy: { schemaVersion: "1.0.0", dialogs: [] },
	}), /requires scenario schemaVersion 2.0.0 or 3.0.0; migrate the v1 dialog policy/);
});

test("declared extension dialog is answered and undeclared dialog is denied", async () => {
	const engine = engineFor("ui", {
		uiPolicy: {
			schemaVersion: "2.0.0",
			dialogs: [{
				request: {
					method: "confirm",
					title: "Approve synthetic action?",
					message: "Only fabricated data is involved.",
				},
				response: { confirmed: true },
			}],
		},
	});
	await engine.start();
	try {
		const run = await engine.promptAndWait("Exercise synthetic UI policy.");
		const result = run.events.find((event) => event.type === "ui_result");
		assert.deepEqual(result, { type: "ui_result", declaredConfirmed: true, undeclaredCancelled: true });
		const uiResponses = engine.getDiagnostics().commands.filter((command) => command.type === "extension_ui_response");
		assert.deepEqual(uiResponses.map(({ id: _id, ...response }) => response), [
			{ type: "extension_ui_response", confirmed: true },
			{ type: "extension_ui_response", cancelled: true },
		]);
	} finally {
		await engine.stop();
	}
});

test("settlement before correlated prompt acceptance is ignored", async () => {
	const engine = engineFor("stale-settled");
	await engine.start();
	try {
		const run = await engine.promptAndWait("Ignore stale synthetic settlement.");
		assert.equal(run.events[0]?.type, "agent_start");
		assert.equal(run.events.filter((event) => event.type === "agent_settled").length, 1);
		assert.equal(run.events.some((event) => event.stale === true), false);
	} finally {
		await engine.stop();
	}
});

test("stop waits for close and retains stderr bytes emitted during shutdown", async () => {
	const engine = engineFor("shutdown-stderr");
	await engine.start();
	await engine.promptAndWait("Complete a fabricated run before shutdown.");
	await engine.stop();
	const diagnostics = engine.getDiagnostics();
	assert.deepEqual(
		Buffer.from(diagnostics.stderrBytes ?? []),
		Buffer.from([0x73, 0x79, 0x6e, 0x74, 0x68, 0x65, 0x74, 0x69, 0x63, 0x2d, 0xff, 0x0a]),
	);
	assert.deepEqual(diagnostics.exit, { code: 0, signal: null });
});

test("accepted prompt waits for agent_settled and captures final RPC state", async () => {
	const engine = engineFor("normal");
	await engine.start();
	const abortAfterSettlement = new AbortController();
	try {
		const run = await engine.promptAndWait("Use only fabricated sensor data.", abortAfterSettlement.signal);
		assert.equal(run.settled, true);
		assert.deepEqual(run.state, { isStreaming: false, sessionId: "synthetic-session" });
		assert.deepEqual(run.messages, [{ role: "assistant", content: "synthetic answer" }]);
		assert.deepEqual(run.entries, { entries: [{ id: "entry-1" }], leafId: "entry-1" });
		assert.deepEqual(run.sessionStats, { totalMessages: 2 });
		assert.equal(run.finalAssistantText, "synthetic answer");
		assert.equal(run.events.at(-1)?.type, "agent_settled");
		abortAfterSettlement.abort();
		assert.equal((await engine.request({ type: "get_state" })).success, true);
	} finally {
		await engine.stop();
	}
});
