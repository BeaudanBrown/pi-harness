import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import * as path from "node:path";

export type AloopEnvironmentEvidence = {
	version: 1;
	status: "ready" | "environment-blocked";
	missing: string[];
	executables: Record<string, string>;
};

export function defaultAloopLauncher(): string[] {
	if (!process.argv[1]) throw new Error("Cannot locate the running Pi CLI script; provide an explicit aloop launcher.");
	return [process.execPath, process.argv[1]];
}

/** Retain project PATH precedence and append only missing fallback entries. */
export function resolveAloopEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env = { ...process.env, ...overrides };
	const parts = env.PATH === undefined ? [] : env.PATH.split(path.delimiter);
	for (const fallback of [env.PI_HARNESS_LSP_FALLBACK_PATH, env.PI_HARNESS_ENGINEERING_RUNTIME_PATH]) {
		for (const entry of (fallback ?? "").split(path.delimiter).filter(Boolean)) if (!parts.includes(entry)) parts.push(entry);
	}
	return { ...env, PATH: parts.join(path.delimiter) };
}

export class AloopEnvironmentError extends Error {
	constructor(readonly evidence: AloopEnvironmentEvidence) {
		super(`Aloop environment blocked: missing ${evidence.missing.join(", ")}. Use the packaged engineering launcher and the repository's documented Nix environment. No worker was started.`);
	}
}

/** Check executable presence, not project build success. Never run a command,
 * install dependencies, or persist the complete environment.
 */
export async function preflightAloopEnvironment(input: {
	cwd: string;
	launcher?: string[];
	canonicalCommand?: string[];
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
}): Promise<AloopEnvironmentEvidence> {
	const inherited = { ...process.env, ...input.env };
	const env = resolveAloopEnvironment(input.env);
	const result: AloopEnvironmentEvidence = { version: 1, status: "ready", missing: [], executables: {} };
	const launcher = input.launcher ?? defaultAloopLauncher();
	const requirements = [["launcher", launcher[0]], ["shell", "bash"], ["git", "git"]];
	if (!input.launcher) requirements.push(["launcher-entrypoint", launcher[1]]);
	if (input.canonicalCommand) requirements.push(["canonical-command", input.canonicalCommand[0]]);
	for (const [role, command] of requirements) {
		input.signal?.throwIfAborted();
		let resolved: string | undefined;
		const executable = role !== "launcher-entrypoint";
		// Canonical verification runs in the supervisor's inherited environment,
		// not the worker's appended fallback environment. Do not attest a command
		// that only the worker could execute.
		const searchPath = role === "canonical-command" ? (inherited.PATH ?? "/usr/bin:/bin") : env.PATH;
		if (command && command.length <= 4_096 && (searchPath?.length ?? 0) <= 65_536) {
			const directories = command.includes("/") ? [""] : (searchPath ?? "").split(path.delimiter).slice(0, 512);
			for (const directory of directories) {
				input.signal?.throwIfAborted();
				const candidate = path.resolve(input.cwd, directory, command);
				try {
					await access(candidate, executable ? constants.X_OK : constants.R_OK);
					if (!(await stat(candidate)).isFile()) continue;
					const canonical = await realpath(candidate);
					if (canonical.length <= 4_096) resolved = canonical;
					break;
				} catch { /* Continue PATH lookup without exposing errors or environment values. */ }
			}
		}
		if (resolved) result.executables[role!] = resolved;
		else { result.status = "environment-blocked"; result.missing.push(role!); }
	}
	input.signal?.throwIfAborted();
	return result;
}
