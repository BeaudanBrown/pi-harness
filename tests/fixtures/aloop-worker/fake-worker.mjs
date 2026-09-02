import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_ALOOP_MODE ?? "success";

if (mode === "timeout") {
	const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	process.stderr.write(`grandchild:${grandchild.pid}\n`);
	setInterval(() => {}, 1000);
} else {
	const commit = (name, content) => {
		writeFileSync(name, content);
		execFileSync("git", ["add", name]);
		execFileSync("git", ["commit", "-m", `fake ${name}`]);
	};
	if (mode === "success" || mode === "multiple-commits" || mode === "replace-result") commit("worker-one.txt", "one\n");
	if (mode === "multiple-commits") commit("worker-two.txt", "two\n");
	if (mode === "replace-result") {
		const attempts = readdirSync(".pi/tmp/aloop").sort();
		const resultPath = `.pi/tmp/aloop/${attempts.at(-1)}/result.json`;
		unlinkSync(resultPath);
		symlinkSync(process.env.FAKE_ALOOP_OUTSIDE, resultPath);
	}
	const result = {
		status: "implemented-and-verified",
		verifiedCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
		summary: "Synthetic implementation completed.",
		verification: ["synthetic check passed"],
		acceptanceCriteria: [{ criterion: "synthetic criterion", satisfied: true, evidence: "fixture evidence" }],
		discoveredWork: [],
		nextAction: "Supervisor should assess the attempt.",
	};
	process.stdout.write(`${JSON.stringify({ type: "session", version: 3 })}\n`);
	process.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(result) }] } })}\n`);
	process.stderr.write("synthetic stderr\n");
}
