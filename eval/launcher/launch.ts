import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { PiRpcEngine, RpcEngineError, type PiRpcEngineOptions } from "../rpc/engine.js";

const execFileAsync = promisify(execFile);
const SENSITIVE = /(api[-_]?key|token|password|secret|credential)/i;
const AUTHORIZATION = /(authorization|proxy-authorization|x-api-key|cookie|set-cookie|bearer\s+|basic\s+|--header(?:=|$))/i;
const URI_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/gi;

export interface EvalLauncherIdentity {
	schemaVersion: "1.0.0";
	launcher: { id: string; path: string; defaultArgs: string[]; requiredResourceBindings: string[] };
	pi: { version: string };
	harness: { revision: string };
	piR: { revision: string; resourceRoot: string; extensionPath: string; skillPath: string };
}

export interface EvalLauncherExpectedIdentity {
	activeModel: { provider: string; id: string };
	piVersion: string;
	harnessRevision: string;
	launcherId: string;
	launcherPath: string;
	piRRevision: string;
	resourceRoot: string;
	extensionPath: string;
	skillPath: string;
	projectRevision: string;
	projectDirty?: boolean;
}

export interface LaunchVerifiedEvalInput {
	identityManifestPath: string;
	projectRoot: string;
	artifactRoot: string;
	expected: EvalLauncherExpectedIdentity;
	args?: string[];
	env?: Record<string, string>;
	concurrency?: number;
	rpc?: Pick<PiRpcEngineOptions, "commandTimeoutMs" | "promptTimeoutMs" | "runTimeoutMs" | "shutdownGraceMs" | "uiPolicy">;
}

export interface EvalRuntimeProvenance {
	schemaVersion: "1.0.0";
	status: "verified" | "failed";
	verifiedBeforePrompt: true;
	runtimeAttestationVerified: boolean;
	launcher: { id: string; path: string; args: string[] };
	pi: { version: string };
	harness: { revision: string };
	piR: { revision: string; resourceRoot: string; extensionPath: string; skillPath: string };
	project: { root: string; revision: string; dirty: boolean };
	activeModel: { provider: string; id: string } | null;
	rpcCommands: string[];
	concurrency: number;
	environment: { inherited: true; overrideKeys: string[]; sensitiveValuesPersisted: false };
	failure?: string;
}

export interface VerifiedEvalLauncher {
	engine: PiRpcEngine;
	provenance: EvalRuntimeProvenance & { status: "verified" };
	stop(): Promise<void>;
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be a string array`);
	return [...value] as string[];
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
	const allowedSet = new Set(allowed);
	const extra = Object.keys(value).filter((key) => !allowedSet.has(key));
	if (extra.length > 0) throw new Error(`${label} has unsupported properties: ${extra.sort().join(", ")}`);
}

function absolutePath(value: unknown, label: string): string {
	const result = string(value, label);
	if (!path.isAbsolute(result) || result.length < 2 || result.includes("\0")) throw new Error(`${label} must be an absolute path`);
	return result;
}

function parseIdentity(value: unknown): EvalLauncherIdentity {
	const root = object(value, "launcher identity");
	exactKeys(root, ["schemaVersion", "launcher", "pi", "harness", "piR"], "launcher identity");
	if (root.schemaVersion !== "1.0.0") throw new Error("Unsupported launcher identity schemaVersion");
	const launcher = object(root.launcher, "launcher identity launcher");
	const pi = object(root.pi, "launcher identity pi");
	const harness = object(root.harness, "launcher identity harness");
	const piR = object(root.piR, "launcher identity piR");
	exactKeys(launcher, ["id", "path", "defaultArgs", "requiredResourceBindings"], "launcher identity launcher");
	exactKeys(pi, ["version"], "launcher identity pi");
	exactKeys(harness, ["revision"], "launcher identity harness");
	exactKeys(piR, ["revision", "resourceRoot", "extensionPath", "skillPath"], "launcher identity piR");
	const requiredResourceBindings = stringArray(launcher.requiredResourceBindings, "launcher requiredResourceBindings");
	if (requiredResourceBindings.length < 3 || new Set(requiredResourceBindings).size !== requiredResourceBindings.length) {
		throw new Error("launcher requiredResourceBindings must contain at least three unique paths");
	}
	return {
		schemaVersion: "1.0.0",
		launcher: {
			id: string(launcher.id, "launcher id"),
			path: absolutePath(launcher.path, "launcher path"),
			defaultArgs: stringArray(launcher.defaultArgs, "launcher defaultArgs"),
			requiredResourceBindings: requiredResourceBindings.map((binding) => absolutePath(binding, "launcher resource binding")),
		},
		pi: { version: string(pi.version, "Pi version") },
		harness: { revision: string(harness.revision, "harness revision") },
		piR: {
			revision: string(piR.revision, "pi-r revision"),
			resourceRoot: absolutePath(piR.resourceRoot, "pi-r resource root"),
			extensionPath: absolutePath(piR.extensionPath, "pi-r extension path"),
			skillPath: absolutePath(piR.skillPath, "pi-r skill path"),
		},
	};
}

function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, stable(item)]));
	return value;
}

async function persist(artifactRoot: string, provenance: EvalRuntimeProvenance): Promise<void> {
	await mkdir(artifactRoot, { recursive: true });
	await writeFile(path.join(artifactRoot, "launcher-provenance.json"), `${JSON.stringify(stable(provenance), null, 2)}\n`, { mode: 0o600 });
}

function contained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function mismatch(label: string, actual: string | boolean, expected: string | boolean): void {
	if (actual !== expected) throw new Error(`${label} mismatch: expected ${String(expected)}, observed ${String(actual)}`);
}

async function gitProjectIdentity(root: string): Promise<{ root: string; revision: string; dirty: boolean }> {
	const canonicalRoot = await realpath(root);
	const revision = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: canonicalRoot, encoding: "utf8" })).stdout.trim();
	const dirty = (await execFileAsync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: canonicalRoot, encoding: "utf8" })).stdout.length > 0;
	return { root: canonicalRoot, revision, dirty };
}

function sensitiveEnvironmentValues(env: Record<string, string>): string[] {
	return Object.entries(env)
		.filter(([key, value]) => SENSITIVE.test(key) && value.length > 0)
		.map(([, value]) => value);
}

function sanitizeEvidenceText(value: string, env: Record<string, string>): string {
	let sanitized = value
		.replace(URI_USERINFO, (match) => `${match.slice(0, match.indexOf("://") + 3)}<redacted>@`)
		.replace(/(authorization|proxy-authorization|x-api-key|cookie|set-cookie)(\s*[:=]\s*)[^,;\n]+/gi, "$1$2<redacted>")
		.replace(/(bearer|basic)\s+[^\s,;]+/gi, "$1 <redacted>")
		.replace(/(api[-_]?key|token|password|secret|credential)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2<redacted>");
	for (const secret of sensitiveEnvironmentValues(env)) sanitized = sanitized.split(secret).join("<redacted>");
	return sanitized;
}

function redactedArgumentManifest(args: string[]): string[] {
	return args.map((argument) => {
		if (!argument.startsWith("-")) return "<redacted>";
		const equals = argument.indexOf("=");
		return equals === -1 ? argument : `${argument.slice(0, equals + 1)}<redacted>`;
	});
}

function assertSafeArguments(args: string[], env: Record<string, string>): void {
	const sensitiveValues = sensitiveEnvironmentValues(env);
	for (const argument of args) {
		URI_USERINFO.lastIndex = 0;
		if (URI_USERINFO.test(argument)) throw new Error("Credentials are forbidden in launcher URI arguments");
		if (SENSITIVE.test(argument) || AUTHORIZATION.test(argument) || sensitiveValues.some((value) => argument.includes(value))) {
			throw new Error("Sensitive values are forbidden in launcher arguments; use inherited provider environment variables");
		}
	}
}

function modelFromState(response: Record<string, unknown>): { provider: string; id: string } {
	if (response.success !== true) throw new Error("get_state failed with redacted child diagnostics");
	const data = object(response.data, "get_state data");
	const model = object(data.model, "active model");
	return { provider: string(model.provider, "active model provider"), id: string(model.id, "active model id") };
}

async function readRuntimeAttestation(file: string): Promise<Record<string, unknown>> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			return object(JSON.parse(await readFile(file, "utf8")), "runtime launcher attestation");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await delay(10);
		}
	}
	throw new Error("Launcher did not emit runtime resource attestation");
}

export async function launchVerifiedEval(input: LaunchVerifiedEvalInput): Promise<VerifiedEvalLauncher> {
	const inheritedEnvironment = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	const effectiveEnvironment = { ...inheritedEnvironment, ...(input.env ?? {}) };
	const concurrency = input.concurrency ?? 1;
	if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Live evaluation concurrency must be a positive integer");
	let engine: PiRpcEngine | null = null;
	let attestationPath: string | null = null;
	let provenance: EvalRuntimeProvenance | null = null;
	try {
		const identity = parseIdentity(JSON.parse(await readFile(input.identityManifestPath, "utf8")));
		const [launcherPath, resourceRoot, extensionPath, skillPath, expectedLauncherPath, expectedResourceRoot, expectedExtensionPath, expectedSkillPath, project] = await Promise.all([
			realpath(identity.launcher.path),
			realpath(identity.piR.resourceRoot),
			realpath(identity.piR.extensionPath),
			realpath(identity.piR.skillPath),
			realpath(input.expected.launcherPath),
			realpath(input.expected.resourceRoot),
			realpath(input.expected.extensionPath),
			realpath(input.expected.skillPath),
			gitProjectIdentity(input.projectRoot),
		]);
		if (!contained(resourceRoot, extensionPath) || !contained(resourceRoot, skillPath)) throw new Error("pi-r extension and skill must be contained by the declared resource root");
		for (const required of [identity.piR.resourceRoot, identity.piR.extensionPath, identity.piR.skillPath]) {
			if (!identity.launcher.requiredResourceBindings.includes(required)) throw new Error(`Launcher identity omits required pi-r binding: ${required}`);
		}
		const args = [...identity.launcher.defaultArgs, ...(input.args ?? [])];
		assertSafeArguments(args, effectiveEnvironment);
		provenance = {
			schemaVersion: "1.0.0",
			status: "failed",
			verifiedBeforePrompt: true,
			runtimeAttestationVerified: false,
			launcher: { id: identity.launcher.id, path: launcherPath, args: redactedArgumentManifest(args) },
			pi: { version: identity.pi.version },
			harness: { revision: identity.harness.revision },
			piR: { revision: identity.piR.revision, resourceRoot, extensionPath, skillPath },
			project,
			activeModel: null,
			rpcCommands: [],
			concurrency,
			environment: { inherited: true, overrideKeys: Object.keys(input.env ?? {}).sort(), sensitiveValuesPersisted: false },
		};
		mismatch("launcher identity", identity.launcher.id, input.expected.launcherId);
		mismatch("launcher path", launcherPath, expectedLauncherPath);
		mismatch("Pi version", identity.pi.version, input.expected.piVersion);
		mismatch("harness revision", identity.harness.revision, input.expected.harnessRevision);
		mismatch("pi-r revision", identity.piR.revision, input.expected.piRRevision);
		mismatch("pi-r resource root", resourceRoot, expectedResourceRoot);
		mismatch("pi-r extension path", extensionPath, expectedExtensionPath);
		mismatch("pi-r skill path", skillPath, expectedSkillPath);
		mismatch("project revision", project.revision, input.expected.projectRevision);
		mismatch("project dirty state", project.dirty, input.expected.projectDirty ?? false);
		await mkdir(input.artifactRoot, { recursive: true });
		attestationPath = path.join(input.artifactRoot, ".launcher-runtime-attestation.json");
		await rm(attestationPath, { force: true });
		engine = new PiRpcEngine({
			command: launcherPath,
			args,
			cwd: project.root,
			env: { ...(input.env ?? {}), PI_EVAL_ATTESTATION_PATH: attestationPath },
			...input.rpc,
		});
		await engine.start();
		const attestation = await readRuntimeAttestation(attestationPath);
		exactKeys(attestation, ["launcherId", "resourceRoot", "extensionPath", "skillPath"], "runtime launcher attestation");
		mismatch("attested launcher identity", string(attestation.launcherId, "attested launcher id"), identity.launcher.id);
		mismatch("attested pi-r resource root", await realpath(string(attestation.resourceRoot, "attested resource root")), resourceRoot);
		mismatch("attested pi-r extension path", await realpath(string(attestation.extensionPath, "attested extension path")), extensionPath);
		mismatch("attested pi-r skill path", await realpath(string(attestation.skillPath, "attested skill path")), skillPath);
		provenance.runtimeAttestationVerified = true;
		await rm(attestationPath, { force: true });
		const activeModel = modelFromState(await engine.request({ type: "get_state" }));
		provenance.rpcCommands = engine.getDiagnostics().commands.map((command) => String(command.type));
		provenance.activeModel = activeModel;
		mismatch("active model provider", activeModel.provider, input.expected.activeModel.provider);
		mismatch("active model id", activeModel.id, input.expected.activeModel.id);
		provenance.status = "verified";
		await persist(input.artifactRoot, provenance);
		return {
			engine,
			provenance: provenance as EvalRuntimeProvenance & { status: "verified" },
			stop: () => engine!.stop(),
		};
	} catch (error) {
		if (engine) await engine.stop();
		if (attestationPath) await rm(attestationPath, { force: true });
		const failure = error instanceof RpcEngineError
			? "RPC runtime verification failed with redacted child diagnostics"
			: sanitizeEvidenceText(error instanceof Error ? error.message : String(error), effectiveEnvironment);
		if (provenance) {
			if (engine) provenance.rpcCommands = engine.getDiagnostics().commands.map((command) => String(command.type));
			provenance.status = "failed";
			provenance.failure = failure;
			await persist(input.artifactRoot, provenance);
		}
		throw new Error(`Evaluation launcher verification failed: ${failure}`);
	}
}
