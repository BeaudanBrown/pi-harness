import { isAbsolute, join } from "node:path";
import { HOST_ERROR_EXITS, isHostMutation, type HostAction, type HostResponse } from "../live-workspace-contracts.js";
import { parseHostCliArgs, hostControlHelp } from "./host-cli-args.js";
import { requestHostControl } from "./host-control-client.js";
import { HostControlError, hostErrorResponse } from "./host-control-error.js";

export function hostControlExit(action: HostAction | undefined, response: HostResponse): number {
	if (!response.ok) return HOST_ERROR_EXITS[response.error.code];
	if (action && isHostMutation(action)) {
		const data = response.data;
		if (("cleanupState" in data && data.cleanupState === "pending") || ("setupState" in data && data.setupState === "pending") ||
			("launchState" in data && ["prepared", "window_created"].includes(data.launchState))) return HOST_ERROR_EXITS.pending;
	}
	return 0;
}

/** Human rendering escapes control/bidi characters in labels; JSON mode retains exact data. */
function humanData(value: unknown): string {
	return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export async function runHostCli(argv: readonly string[], environment: NodeJS.ProcessEnv, io: { stdout: (text: string) => void; stderr: (text: string) => void }): Promise<number> {
	const json = argv.includes("--json"); let id = "cli-invalid"; let action: HostAction | undefined; let response: HostResponse;
	try {
		const parsed = parseHostCliArgs(argv);
		if ("help" in parsed) { io.stdout(`${hostControlHelp()}\n`); return 0; }
		id = parsed.request.actor.requestId; action = parsed.request.action;
		const directory = environment.PI_MANAGED_SESSIONS_RUNTIME_DIR?.trim() || (environment.XDG_RUNTIME_DIR ? join(environment.XDG_RUNTIME_DIR, "pi-managed-sessions") : undefined);
		if (!directory || !isAbsolute(directory)) throw new HostControlError("unavailable", "Managed host controls are unavailable", true);
		response = await requestHostControl({ socketPath: join(directory, "control.sock"), action, requestId: id });
	} catch (error) { response = hostErrorResponse(id, error); }
	if (json) io.stdout(`${JSON.stringify(response)}\n`);
	else if (response.ok) io.stdout(`${action!.operation}\n${humanData(response.data)}\n`);
	if (!response.ok) io.stderr(`${response.error.code}: ${response.error.message}\n`);
	return hostControlExit(action, response);
}

if (require.main === module) {
	process.stdout.on("error", (error: NodeJS.ErrnoException) => { process.exitCode = error.code === "EPIPE" ? 0 : 9; });
	void runHostCli(process.argv.slice(2), process.env, { stdout: (text) => { process.stdout.write(text); }, stderr: (text) => { process.stderr.write(text); } })
		.then((code) => { process.exitCode = code; }).catch(() => { process.stderr.write("Host control CLI failed\n"); process.exitCode = 9; });
}
