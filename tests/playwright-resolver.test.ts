import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const resolver = path.resolve("bin/pi-playwright");

async function makeExecutable(file: string, body: string): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, "utf8");
	await chmod(file, 0o755);
}

async function runResolver(root: string, args: string[], env: Record<string, string> = {}) {
	return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn("bash", [resolver, ...args], {
			cwd: root,
			env: {
				...process.env,
				PI_PLAYWRIGHT_ROOT: root,
				PI_HARNESS_JQ: process.env.PI_HARNESS_JQ || process.env.JQ || "jq",
				...env,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

test("project manifest adapter takes precedence over the harness fallback", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-playwright-project-"));
	const calls = path.join(root, "calls.txt");
	await makeExecutable(path.join(root, "project-cli"), `printf 'project:%s\\n' "$*" >> ${JSON.stringify(calls)}\nif [ "\${1-}" = "--version" ]; then echo project-1.2.3; fi`);
	await makeExecutable(path.join(root, "fallback-cli"), `printf 'fallback:%s\\n' "$*" >> ${JSON.stringify(calls)}`);
	await mkdir(path.join(root, ".pi"), { recursive: true });
	await writeFile(
		path.join(root, ".pi/playwright-cli.json"),
		JSON.stringify({ version: 1, command: [path.join(root, "project-cli")] }),
	);

	const result = await runResolver(root, ["snapshot"], {
		PI_HARNESS_PLAYWRIGHT_FALLBACK: path.join(root, "fallback-cli"),
	});

	assert.equal(result.code, 0, result.stderr);
	assert.equal(await readFile(calls, "utf8"), "project:snapshot\n");
});

test("fallback is selected in a project without Playwright", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-playwright-fallback-"));
	const calls = path.join(root, "calls.txt");
	await makeExecutable(path.join(root, "fallback-cli"), `printf '%s\\n' "$*" > ${JSON.stringify(calls)}`);

	const result = await runResolver(root, ["open", "https://example.com"], {
		PI_HARNESS_PLAYWRIGHT_FALLBACK: path.join(root, "fallback-cli"),
		XDG_CACHE_HOME: path.join(root, "cache"),
	});

	assert.equal(result.code, 0, result.stderr);
	assert.equal(await readFile(calls, "utf8"), "open https://example.com\n");
	assert.match(result.stderr, /using harness fallback/);
});

test("doctor reports the selected adapter and CLI version", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-playwright-doctor-"));
	await makeExecutable(path.join(root, "fallback-cli"), 'if [ "${1-}" = "--version" ]; then echo 9.8.7; fi');

	const result = await runResolver(root, ["doctor"], {
		PI_HARNESS_PLAYWRIGHT_FALLBACK: path.join(root, "fallback-cli"),
	});

	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /adapter: harness-fallback/);
	assert.match(result.stdout, /version: 9\.8\.7/);
	assert.match(result.stdout, new RegExp(`workspace: ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("invalid project manifests fail closed instead of falling back", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-playwright-invalid-"));
	await mkdir(path.join(root, ".pi"), { recursive: true });
	await writeFile(path.join(root, ".pi/playwright-cli.json"), JSON.stringify({ version: 1, command: "bad" }));
	await makeExecutable(path.join(root, "fallback-cli"), "exit 0");

	const result = await runResolver(root, ["snapshot"], {
		PI_HARNESS_PLAYWRIGHT_FALLBACK: path.join(root, "fallback-cli"),
	});

	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /invalid project adapter manifest/);
});
