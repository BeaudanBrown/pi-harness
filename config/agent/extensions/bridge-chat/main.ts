import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { matrixDelay } from "../matrix-shared/http.js";
import { OwnerMatrix, Store, object, validateConfig } from "./transport.js";
import { modelAnswer } from "./socket.js";
import { transportFailure, type TransportStage } from "./diagnostics.js";

let stage: TransportStage = "configuration";
function enterStage(next: TransportStage): void {
	stage = next;
	console.log(JSON.stringify({ event: "transport_stage", stage }));
}

export function readToken(filename: string): string {
	const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const st = fs.fstatSync(fd);
		// systemd LoadCredential uses 0440 when the unit declares Group=.
		// Permit read access only for the process's effective group, never
		// group write/execute or any access for other users.
		const foreignGroupRead = (st.mode & 0o040) !== 0 && st.gid !== process.getegid?.();
		if (!st.isFile() || (st.mode & 0o037) || foreignGroupRead || st.size > 4097) throw Error("Credential file");
		return fs.readFileSync(fd, "utf8").trim();
	} finally { fs.closeSync(fd); }
}
async function main(): Promise<void> {
	process.umask(0o077);
	enterStage("configuration");
	const config = validateConfig(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
	enterStage("credential_read");
	const token = readToken(path.join(process.env.CREDENTIALS_DIRECTORY!, "matrix"));
	enterStage("matrix_client");
	const matrix = new OwnerMatrix({ homeserver: config.homeserver, accessToken: token });
	const stop = new AbortController();
	process.on("SIGTERM", () => stop.abort());
	enterStage("identity_request");
	const identity = object(await matrix.http.request("GET", "/_matrix/client/v3/account/whoami", undefined, stop.signal));
	enterStage("identity_validation");
	if (identity.user_id !== config.ownerUserId || identity.is_guest === true || typeof identity.device_id !== "string" || !identity.device_id) throw Error("Dedicated owner login required");
	enterStage("database_open");
	const store = new Store(path.join(process.env.STATE_DIRECTORY!, "requests.sqlite"));
	try {
		enterStage("policy_initialization");
		// Versioned policy also discards pre-TypeScript pending work without replaying history.
		const fingerprint = createHash("sha256").update("typescript-v1:" + JSON.stringify(config) + token).digest("hex");
		let fresh = store.get("identity") !== fingerprint || !store.get("cursor");
		if (fresh) store.resetPolicy();
		enterStage("running");
		while (!stop.signal.aborted) {
			try {
				const batch = await matrix.sync(fresh ? "" : store.get("cursor"), [config.ownerUserId, ...config.remoteOwnerUserIds], store.pending(), stop.signal);
				const dropped = store.ingest(batch, config, Date.now(), fresh);
				store.atomic(() => store.put("identity", fingerprint));
				if (fresh) console.log('{"event":"watermark_initialized"}');
				fresh = false;
				if (dropped) console.log(JSON.stringify({ event: "queue_saturated", dropped }));
			} catch {
				if (stop.signal.aborted) break;
				console.log('{"event":"sync_unavailable"}');
				await matrixDelay(5000, stop.signal).catch(() => {}); continue;
			}
			await store.step(matrix, q => modelAnswer(config.modelSocket, q, stop.signal), config, Date.now, stop.signal);
		}
	} finally { store.close(); }
}
void main().catch(error => { console.error(transportFailure(stage, error)); process.exitCode = 1; });
