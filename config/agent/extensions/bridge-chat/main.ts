import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { matrixDelay } from "../matrix-shared/http.js";
import { OwnerMatrix, Store, object, validateConfig } from "./transport.js";
import { modelAnswer } from "./socket.js";

export function readToken(filename: string): string {
	const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const st = fs.fstatSync(fd);
		if (!st.isFile() || (st.mode & 0o077) || st.size > 4097) throw Error("Credential file");
		return fs.readFileSync(fd, "utf8").trim();
	} finally { fs.closeSync(fd); }
}
async function main(): Promise<void> {
	process.umask(0o077);
	const config = validateConfig(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
	const token = readToken(path.join(process.env.CREDENTIALS_DIRECTORY!, "matrix"));
	const matrix = new OwnerMatrix({ homeserver: config.homeserver, accessToken: token });
	const stop = new AbortController();
	process.on("SIGTERM", () => stop.abort());
	const identity = object(await matrix.http.request("GET", "/_matrix/client/v3/account/whoami", undefined, stop.signal));
	if (identity.user_id !== config.ownerUserId || identity.is_guest === true || typeof identity.device_id !== "string" || !identity.device_id) throw Error("Dedicated owner login required");
	const store = new Store(path.join(process.env.STATE_DIRECTORY!, "requests.sqlite"));
	// Versioned policy also discards pre-TypeScript pending work without replaying history.
	const fingerprint = createHash("sha256").update("typescript-v1:" + JSON.stringify(config) + token).digest("hex");
	let fresh = store.get("identity") !== fingerprint || !store.get("cursor");
	if (fresh) store.resetPolicy();
	try {
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
void main().catch(() => { console.error("pi-chat-transport: stopped (details redacted)"); process.exitCode = 1; });
