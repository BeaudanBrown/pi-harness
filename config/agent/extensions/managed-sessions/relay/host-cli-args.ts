import { randomUUID } from "node:crypto";
import { Type, type TSchema } from "typebox";
import { HOST_CONTROL_VERSION, HostActionSchema, parseHostRequest, type HostRequest } from "../live-workspace-contracts.js";
import { HostControlError } from "./host-control-error.js";

const flagName = (field: string) => `--${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
function invalid(message: string): never { throw new HostControlError("invalid_request", message); }
function fields(schema: typeof HostActionSchema.anyOf[number]): Record<string, TSchema> {
	const result: Record<string, TSchema> = { ...schema.properties }; delete result.operation;
	if ("placement" in schema.properties) { delete result.placement; Object.assign(result, schema.properties.placement.properties); }
	return result;
}

export function hostControlHelp(): string {
	return ["Usage: pi-managed-session <noun> <action> ... [--request-id ID] [--json]", "",
		...HostActionSchema.anyOf.map((schema) => {
			const args = Object.entries(fields(schema)).map(([name, value]) => name === "conversationId" ? "<conversation-id>" : `${flagName(name)}${Type.IsLiteral(value) && value.const === true ? "" : Type.IsArray(value) ? " <id,id,...>" : " <value>"}`);
			return `  ${schema.properties.operation.const.replaceAll(".", " ")} ${args.join(" ")}`.trimEnd();
		}), "", "Single conversation IDs are exact positionals. Bulk IDs are comma-separated.",
		"--confirmed is a flag. --relative-cwd defaults to empty. Inventory limit/cursor are optional.",
		"Legacy delete/close <conversation-id> --confirm aliases perform permanent canonical retirement.",
		"Host policy and supported capabilities may restrict listed actions."].join("\n");
}

export function parseHostCliArgs(input: readonly string[]): { request: HostRequest; json: boolean } | { help: true; json: false } {
	// Legacy deletion spellings retain canonical retirement, never unbinding.
	const argv = input[0] === "delete" || input[0] === "close" ? ["conversation", "delete", ...input.slice(1).map(a => a === "--confirm" ? "--confirmed" : a)] : input;
	if (argv.length > 256 || argv.reduce((size, value) => size + Buffer.byteLength(value), 0) > 60 * 1024) invalid("Host command exceeds argument bounds");
	const args: string[] = []; let json = false; let help = false; let requestId: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") { if (json) invalid("Duplicate --json flag"); json = true; }
		else if (arg === "--help") { if (help) invalid("Duplicate --help flag"); help = true; }
		else if (arg === "--request-id") {
			if (requestId !== undefined || !argv[i + 1] || argv[i + 1].startsWith("--")) invalid("Invalid --request-id argument");
			requestId = argv[++i];
		} else args.push(arg);
	}
	if (help) { if (json) invalid("Use --help without --json"); return { help: true, json: false }; }
	const schema = [...HostActionSchema.anyOf].sort((a, b) => b.properties.operation.const.split(".").length - a.properties.operation.const.split(".").length)
		.find((candidate) => candidate.properties.operation.const.split(".").every((word, i) => args[i] === word));
	if (!schema) invalid("Unknown host operation; use --help");
	const properties = fields(schema); const flags = new Map(Object.keys(properties).filter((name) => name !== "conversationId").map((name) => [flagName(name), name]));
	const values: Record<string, unknown> = {};
	for (let i = schema.properties.operation.const.split(".").length; i < args.length; i++) {
		const arg = args[i];
		if (!arg.startsWith("--")) {
			if (!("conversationId" in properties) || "conversationId" in values) invalid("Unexpected positional argument; use exact conversation IDs");
			values.conversationId = arg; continue;
		}
		const equals = arg.indexOf("="); const flag = equals < 0 ? arg : arg.slice(0, equals);
		const name = flags.get(flag); if (!name) invalid("Unknown host option; use --help");
		if (Object.hasOwn(values, name)) invalid("Duplicate host option");
		const property = properties[name];
		if (Type.IsLiteral(property) && property.const === true) { if (equals >= 0) invalid("Confirmation is a flag, not a value"); values[name] = true; continue; }
		const value = equals < 0 ? args[++i] : arg.slice(equals + 1);
		if (value === undefined || (equals < 0 && value.startsWith("--"))) invalid("Host option requires a value");
		if (Type.IsInteger(property)) { if (!/^[0-9]+$/.test(value)) invalid("Host option requires a bounded integer"); values[name] = Number(value); }
		else values[name] = Type.IsArray(property) ? value.split(",") : value;
	}
	const action: Record<string, unknown> = { operation: schema.properties.operation.const, ...values };
	if ("placement" in schema.properties) {
		action.placement = { rootKey: values.rootKey, workspace: values.workspace, relativeCwd: values.relativeCwd ?? "" };
		delete action.rootKey; delete action.workspace; delete action.relativeCwd;
	}
	try { return { json, request: parseHostRequest({ version: HOST_CONTROL_VERSION, actor: { kind: "human_local", requestId: requestId ?? `cli-${randomUUID()}` }, action }) }; }
	catch { return invalid("Invalid host action fields; use --help"); }
}
