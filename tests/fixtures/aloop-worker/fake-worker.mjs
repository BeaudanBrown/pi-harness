import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_ALOOP_MODE ?? "success";

if (mode === "timeout") {
	const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	process.stderr.write(`grandchild:${grandchild.pid}\n`);
	writeFileSync("timeout-partial.txt", "preserve me\n");
	setInterval(() => {}, 1000);
} else {
	const commit = (name, content) => {
		writeFileSync(name, content);
		execFileSync("git", ["add", name]);
		execFileSync("git", ["commit", "-m", `fake ${name}`]);
	};
	if (["success", "multiple-commits", "replace-result", "environment", "patch"].includes(mode)) commit("worker-one.txt", "one\n");
	if (mode === "environment") commit("worker-environment.json", `${JSON.stringify({ path: process.env.PATH, argv: process.argv.slice(2) }, null, 2)}\n`);
	if (mode === "multiple-commits") commit("worker-two.txt", "two\n");
	if (mode === "replace-result") {
		const attempts = readdirSync(".pi/tmp/aloop").sort();
		const resultPath = `.pi/tmp/aloop/${attempts.at(-1)}/result.json`;
		unlinkSync(resultPath);
		symlinkSync(process.env.FAKE_ALOOP_OUTSIDE, resultPath);
	}
	if (mode === "patch") {
		writeFileSync(process.env.PI_ALOOP_SUBMISSION_PATH, `${JSON.stringify({ version: 1, status: "patched", summary: "Patched.", verification: ["focused pass"], nextAction: "Review." })}\n`, { mode: 0o600 });
	} else if (mode !== "missing-submission") {
		const changed = !["no-commit", "dirty", "missing-submission"].includes(mode);
		const result = {
			version: 1,
			status: changed ? "candidate-complete" : mode === "no-commit" ? "already-satisfied" : "incomplete",
			summary: "Synthetic implementation completed.",
			verification: ["synthetic check passed"],
			acceptanceCriteria: [{ criterion: "synthetic criterion", satisfied: changed, evidence: "fixture evidence" }],
			discoveredWork: [],
			nextAction: "Supervisor should assess the attempt.",
		};
		writeFileSync(process.env.PI_ALOOP_SUBMISSION_PATH, `${JSON.stringify(result)}\n`, { mode: 0o600 });
	}
	if (mode === "dirty") writeFileSync("dirty.txt", "preserve me\n");
	process.stdout.write(`${JSON.stringify({ type: "session", version: 3 })}\n`);
	process.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "fake", model: "worker", usage: { input: 7, output: 3, cost: { total: 0.01 } }, content: [] } })}\n`);
	process.stderr.write("synthetic stderr\n");
}
