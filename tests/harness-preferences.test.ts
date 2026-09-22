import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPreference, savePreference } from "../config/agent/extensions/shared/preferences.js";
import { extractAssistantText, workerResourceLoader } from "../config/agent/extensions/shared/worker-session.js";

test("extension preferences migrate on save without ever rewriting Pi settings", async t => {
	const dir = await mkdtemp(join(tmpdir(), "harness-prefs-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const settings = JSON.stringify({ "pi-codex-fast": { enabled: false }, "pi-worker-runner": { mode: "luna" }, theme: "dark" });
	await writeFile(join(dir, "settings.json"), settings);
	assert.deepEqual(await loadPreference("pi-worker-runner", dir), { mode: "luna" });
	await Promise.all([
		savePreference("pi-worker-runner", { selection: { kind: "preset", preset: "spark" } }, dir),
		savePreference("pi-codex-fast", { enabled: true }, dir),
	]);
	assert.deepEqual(await loadPreference("pi-codex-fast", dir), { enabled: true });
	assert.deepEqual(await loadPreference("pi-worker-runner", dir), { selection: { kind: "preset", preset: "spark" } });
	assert.equal(await readFile(join(dir, "settings.json"), "utf8"), settings);
	await Promise.all(Array.from({ length: 12 }, (_, value) => savePreference("same-owner", { value }, dir)));
	assert.equal(typeof (await loadPreference("same-owner", dir) as { value: number }).value, "number");
	assert.ok(!(await readdir(dir)).some(file => file.endsWith(".tmp")));
	await writeFile(join(dir, "pi-codex-fast.json"), "malformed");
	await assert.rejects(loadPreference("pi-codex-fast", dir), SyntaxError);
});

test("shared worker loader remains resource-free and selects the intended prompt", () => {
	for (const name of ["review-worker", "diagnostic-worker"] as const) {
		const loader = workerResourceLoader(name, () => ({}) as any);
		assert.deepEqual(loader.getExtensions().extensions, []);
		assert.deepEqual(loader.getSkills().skills, []);
		assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
		assert.match(loader.getSystemPrompt()!, name === "review-worker" ? /code-review/ : /diagnostic/);
	}
	assert.equal(extractAssistantText({ messages: [{ role: "assistant", content: [{ type: "text", text: "old" }] },
		{ role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "answer" }] }] }), "answer");
});
