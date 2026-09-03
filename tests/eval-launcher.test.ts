import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { launchVerifiedEval } from "../eval/launcher/launch.js";

const execFileAsync = promisify(execFile);

async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-eval-launcher-"));
	const projectRoot = path.join(root, "project");
	const lockedRoot = path.join(root, "locked-pi-r");
	const candidateRoot = path.join(root, "candidate-pi-r");
	await Promise.all([
		mkdir(projectRoot),
		mkdir(path.join(lockedRoot, "extensions"), { recursive: true }),
		mkdir(path.join(lockedRoot, "skills"), { recursive: true }),
		mkdir(path.join(candidateRoot, "extensions"), { recursive: true }),
		mkdir(path.join(candidateRoot, "skills"), { recursive: true }),
	]);
	await writeFile(path.join(projectRoot, "fabricated.txt"), "synthetic\n");
	await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
	await execFileAsync("git", ["-c", "user.name=Synthetic Evaluator", "-c", "user.email=evaluator.invalid", "add", "."], { cwd: projectRoot });
	await execFileAsync("git", ["-c", "user.name=Synthetic Evaluator", "-c", "user.email=evaluator.invalid", "commit", "-qm", "synthetic fixture"], { cwd: projectRoot });
	const projectRevision = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectRoot })).stdout.trim();
	const extensionPath = path.join(candidateRoot, "extensions", "index.ts");
	const skillPath = path.join(candidateRoot, "skills", "SKILL.md");
	await writeFile(extensionPath, "export const candidate = 'synthetic';\n");
	await writeFile(skillPath, "# Synthetic candidate skill\n");
	await writeFile(path.join(lockedRoot, "extensions", "index.ts"), "export const locked = 'synthetic';\n");
	await writeFile(path.join(lockedRoot, "skills", "SKILL.md"), "# Synthetic locked skill\n");
	const launcherPath = path.join(root, "candidate-launcher");
	await writeFile(launcherPath, `#!${process.env.PI_TEST_SHELL ?? "/bin/sh"}\nPI_R_RESOURCE_ROOT=${JSON.stringify(candidateRoot)}\nPI_R_EXTENSION=${JSON.stringify(extensionPath)}\nPI_R_SKILL=${JSON.stringify(skillPath)}\nprintf '{"launcherId":"pi-r-local","resourceRoot":"%s","extensionPath":"%s","skillPath":"%s"}\\n' "$PI_R_RESOURCE_ROOT" "$PI_R_EXTENSION" "$PI_R_SKILL" > "$PI_EVAL_ATTESTATION_PATH"\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
	await chmod(launcherPath, 0o755);
	const identityPath = path.join(root, "identity.json");
	await writeFile(identityPath, `${JSON.stringify({
		schemaVersion: "1.0.0",
		launcher: {
			id: "pi-r-local",
			path: launcherPath,
			defaultArgs: [path.resolve("tests/fixtures/eval-rpc/fake-rpc.mjs")],
			requiredResourceBindings: [candidateRoot, extensionPath, skillPath],
		},
		pi: { version: "0.80.6-synthetic" },
		harness: { revision: "harness-synthetic-revision" },
		piR: { revision: "candidate-synthetic-revision", resourceRoot: candidateRoot, extensionPath, skillPath },
	}, null, 2)}\n`);
	return { root, projectRoot, lockedRoot, candidateRoot, extensionPath, skillPath, launcherPath, identityPath, projectRevision };
}

function options(value: Awaited<ReturnType<typeof fixture>>) {
	return {
		identityManifestPath: value.identityPath,
		projectRoot: value.projectRoot,
		artifactRoot: path.join(value.root, "artifacts"),
		env: {
			FAKE_RPC_MODEL_PROVIDER: "local-synthetic",
			FAKE_RPC_MODEL_ID: "fabricated-model",
		} as Record<string, string>,
		expected: {
			activeModel: { provider: "local-synthetic", id: "fabricated-model" },
			piVersion: "0.80.6-synthetic",
			harnessRevision: "harness-synthetic-revision",
			launcherId: "pi-r-local",
			launcherPath: value.launcherPath,
			piRRevision: "candidate-synthetic-revision",
			resourceRoot: value.candidateRoot,
			extensionPath: value.extensionPath,
			skillPath: value.skillPath,
			projectRevision: value.projectRevision,
		},
	};
}

test("candidate checkout resources and active runtime are verified before prompting", async () => {
	const value = await fixture();
	const opaqueArgument = "opaque-runtime-value";
	const launched = await launchVerifiedEval({ ...options(value), args: ["--label", opaqueArgument] });
	try {
		assert.equal(launched.provenance.piR.revision, "candidate-synthetic-revision");
		assert.equal(launched.provenance.piR.resourceRoot, await realpath(value.candidateRoot));
		assert.notEqual(launched.provenance.piR.resourceRoot, await realpath(value.lockedRoot));
		assert.deepEqual(launched.engine.getDiagnostics().commands.map((command) => command.type), ["get_state"]);
		assert.equal(launched.provenance.concurrency, 1);
		const persisted = await readFile(path.join(value.root, "artifacts", "launcher-provenance.json"), "utf8");
		assert.doesNotMatch(persisted, new RegExp(opaqueArgument));
		assert.deepEqual(JSON.parse(persisted).launcher.args.slice(-2), ["--label", "<redacted>"]);
	} finally {
		await launched.stop();
	}
});

test("identity mismatch fails before any scenario prompt and retains redacted evidence", async () => {
	const value = await fixture();
	const input = options(value);
	input.expected.piRRevision = "different-candidate";
	await assert.rejects(launchVerifiedEval(input), /pi-r revision mismatch/);
	const evidence = await readFile(path.join(value.root, "artifacts", "launcher-provenance.json"), "utf8");
	assert.match(evidence, /"status": "failed"/);
	assert.doesNotMatch(evidence, /"type": "prompt"/);
});

test("runtime resource fallback fails before get_state or any prompt", async () => {
	const value = await fixture();
	const launcher = await readFile(value.launcherPath, "utf8");
	await writeFile(value.launcherPath, launcher.split(value.candidateRoot).join(value.lockedRoot));
	await assert.rejects(launchVerifiedEval(options(value)), /attested pi-r resource root mismatch/);
	const evidence = JSON.parse(await readFile(path.join(value.root, "artifacts", "launcher-provenance.json"), "utf8")) as { rpcCommands: string[]; runtimeAttestationVerified: boolean };
	assert.deepEqual(evidence.rpcCommands, []);
	assert.equal(evidence.runtimeAttestationVerified, false);
});

test("active model mismatch stops after get_state without sending a prompt", async () => {
	const value = await fixture();
	const input = options(value);
	input.expected.activeModel.id = "unexpected-model";
	await assert.rejects(launchVerifiedEval(input), /active model id mismatch/);
	const evidence = JSON.parse(await readFile(path.join(value.root, "artifacts", "launcher-provenance.json"), "utf8")) as { rpcCommands: string[]; status: string };
	assert.deepEqual(evidence.rpcCommands, ["get_state"]);
	assert.equal(evidence.status, "failed");
});

test("RPC errors are scrubbed before failure evidence is persisted", async () => {
	const value = await fixture();
	const input = options(value);
	input.env.FAKE_RPC_MODE = "state-sensitive-error";
	await assert.rejects(
		launchVerifiedEval(input),
		(error: unknown) => error instanceof Error
			&& !error.message.includes("child-emitted-secret")
			&& error.message.includes("redacted child diagnostics"),
	);
	const evidence = await readFile(path.join(value.root, "artifacts", "launcher-provenance.json"), "utf8");
	assert.doesNotMatch(evidence, /child-emitted-secret/);
	assert.match(evidence, /redacted child diagnostics/);
});

test("runtime parsing enforces the strict versioned identity schema", async () => {
	const extra = await fixture();
	const extraIdentity = JSON.parse(await readFile(extra.identityPath, "utf8")) as Record<string, unknown>;
	extraIdentity.unexpected = true;
	await writeFile(extra.identityPath, JSON.stringify(extraIdentity));
	await assert.rejects(launchVerifiedEval(options(extra)), /unsupported properties: unexpected/);

	const relative = await fixture();
	const relativeIdentity = JSON.parse(await readFile(relative.identityPath, "utf8")) as { launcher: { path: string } };
	relativeIdentity.launcher.path = "relative-launcher";
	await writeFile(relative.identityPath, JSON.stringify(relativeIdentity));
	await assert.rejects(launchVerifiedEval(options(relative)), /launcher path must be an absolute path/);
});

test("sensitive launcher arguments are rejected and explicit concurrency is bounded", async () => {
	const value = await fixture();
	await assert.rejects(launchVerifiedEval({ ...options(value), args: ["--api-key", "opaque-value"] }), /Sensitive values are forbidden in launcher arguments/);
	await assert.rejects(launchVerifiedEval({ ...options(value), args: ["--header=Authorization: Bearer opaque-value"] }), /Sensitive values are forbidden in launcher arguments/);
	await assert.rejects(launchVerifiedEval({ ...options(value), args: ["--endpoint=https://operator:password@example.invalid/v1"] }), /Credentials are forbidden in launcher URI arguments/);
	await assert.rejects(launchVerifiedEval({ ...options(value), concurrency: 0 }), /concurrency must be a positive integer/);
});
