import { createHash } from "node:crypto";

export const DEFAULT_ALOOP_COMMAND_TIMEOUT_MS = 30 * 60_000;
export const MAX_ALOOP_COMMAND_TIMEOUT_MS = 4 * 60 * 60_000;

export type AloopCommandDefinition = {
	argv: string[];
	timeoutMs: number;
};

export type AloopVerificationPolicy = {
	canonicalCommand: AloopCommandDefinition;
	workerFeedbackCommand?: AloopCommandDefinition;
	productionIntegration?: {
		frequency: "issue" | "epic";
		command: AloopCommandDefinition;
	};
	workerResources: { extensions: string[]; tools: string[] };
	patchWorkerModel?: string;
};

export type AloopPolicySnapshot = {
	version: 1;
	startCommit: string;
	sha256: string;
	policy: AloopVerificationPolicy;
};

function record(value: unknown, field: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
	return value as Record<string, unknown>;
}

function command(value: unknown, field: string): AloopCommandDefinition {
	const object = record(value, `.aloop.json ${field}`);
	const argv = object.argv;
	if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== "string" || !part)) {
		throw new Error(`.aloop.json ${field}.argv must be a non-empty string array.`);
	}
	const timeout = object.timeoutMs ?? DEFAULT_ALOOP_COMMAND_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeout) || Number(timeout) < 1 || Number(timeout) > MAX_ALOOP_COMMAND_TIMEOUT_MS) {
		throw new Error(`.aloop.json ${field}.timeoutMs must be an integer between 1 and ${MAX_ALOOP_COMMAND_TIMEOUT_MS}.`);
	}
	return { argv: argv as string[], timeoutMs: Number(timeout) };
}

function optionalModel(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) throw new Error(".aloop.json patchWorkerModel must be a non-empty model reference.");
	return value.trim();
}

function stringArray(value: unknown, field: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
		throw new Error(`.aloop.json ${field} must be an array of non-empty strings.`);
	}
	return value as string[];
}

export function parseAloopVerificationPolicy(document: string): AloopVerificationPolicy {
	let parsed: unknown;
	try { parsed = JSON.parse(document); } catch (error) {
		throw new Error(`.aloop.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const value = record(parsed, ".aloop.json");
	if (typeof value.canonicalCommand === "string" || typeof value.productionIntegrationCommand === "string") {
		throw new Error(".aloop.json uses the legacy shell-string schema; migrate commands to explicit argv objects.");
	}
	if (value.canonicalCommand === undefined) throw new Error(".aloop.json must declare canonicalCommand.");
	const resources = value.workerResources === undefined ? {} : record(value.workerResources, ".aloop.json workerResources");
	let productionIntegration: AloopVerificationPolicy["productionIntegration"];
	if (value.productionIntegration !== undefined) {
		const production = record(value.productionIntegration, ".aloop.json productionIntegration");
		if (production.frequency !== "issue" && production.frequency !== "epic") {
			throw new Error('.aloop.json productionIntegration.frequency must be "issue" or "epic".');
		}
		productionIntegration = { frequency: production.frequency, command: command(production.command, "productionIntegration.command") };
	}
	return {
		canonicalCommand: command(value.canonicalCommand, "canonicalCommand"),
		...(value.workerFeedbackCommand === undefined ? {} : { workerFeedbackCommand: command(value.workerFeedbackCommand, "workerFeedbackCommand") }),
		...(productionIntegration ? { productionIntegration } : {}),
		workerResources: {
			extensions: stringArray(resources.extensions, "workerResources.extensions"),
			tools: stringArray(resources.tools, "workerResources.tools"),
		},
		...(optionalModel(value.patchWorkerModel) ? { patchWorkerModel: optionalModel(value.patchWorkerModel) } : {}),
	};
}

export function snapshotAloopPolicy(document: string, startCommit: string): AloopPolicySnapshot {
	if (!/^[0-9a-f]{7,64}$/i.test(startCommit)) throw new Error("Aloop policy snapshot requires a Git commit ID.");
	return {
		version: 1,
		startCommit,
		sha256: createHash("sha256").update(document, "utf8").digest("hex"),
		policy: parseAloopVerificationPolicy(document),
	};
}
