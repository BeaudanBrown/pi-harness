import fs from "node:fs";
import path from "node:path";
import { matrixDelay } from "../matrix-shared/http.js";
import { OwnerMatrix, Store, object, validateConfig, assistantPolicyFingerprint } from "./transport.js";
import { AccountStore } from "./account-store.js";
import { AccountWorker } from "./account-worker.js";
import { AccountMatrix } from "./account-matrix.js";
import { AccountRules } from "./account-notifications.js";
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
		// systemd may expose a readable root:root 0440 credential even when
		// neither ID matches this DynamicUser process. Accept that exact
		// read-only case as well as effective-group read access; never relax
		// the checks for group write/execute or any other-user permissions.
		const rootReadOnly = st.uid === 0 && st.gid === 0 && (st.mode & 0o7777) === 0o440;
		const foreignGroupRead = (st.mode & 0o040) !== 0 && st.gid !== process.getegid?.() && !rootReadOnly;
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
	const matrix = new OwnerMatrix({ homeserver: config.homeserver, accessToken: token, filesDirectory: config.filesDirectory });
	const stop = new AbortController();
	process.on("SIGTERM", () => stop.abort());
	enterStage("identity_request");
	const identity = object(await matrix.http.request("GET", "/_matrix/client/v3/account/whoami", undefined, stop.signal));
	enterStage("identity_validation");
	if (identity.user_id !== config.ownerUserId || identity.is_guest === true || typeof identity.device_id !== "string" || !identity.device_id) throw Error("Dedicated owner login required");
	enterStage("database_open");
	const store = new Store(path.join(process.env.STATE_DIRECTORY!, "requests.sqlite"));
	let accountStore: AccountStore | undefined; let accountTask: Promise<void> | undefined;
	try {
		const hosts = config.managedAccountHosts ?? [];
		if (hosts.length) accountStore = new AccountStore(path.join(process.env.STATE_DIRECTORY!, "managed-account.sqlite"), config.ownerUserId);
		const accounts = accountStore ? new AccountWorker(accountStore, hosts, config.ownerUserId, new AccountMatrix(matrix.http), new AccountRules(matrix.http)) : undefined;
		enterStage("policy_initialization");
		// Versioned policy also discards pre-TypeScript pending work without replaying history.
		const fingerprint = assistantPolicyFingerprint(config, token);
		let fresh = store.get("identity") !== fingerprint || !store.get("cursor");
		if (fresh) store.resetPolicy();
		enterStage("running");
		// Separate bounded work: NAS/account outages do not occupy model requests or
		// delay the shared sync cursor while waiting for account HTTP effects.
		if (accounts) accountTask = (async () => {
			while (!stop.signal.aborted) {
				try { await accounts.step(AbortSignal.any([stop.signal, AbortSignal.timeout(5000)])); } catch { console.log('{"event":"managed_account_unavailable"}'); }
				try { await accounts.flush(AbortSignal.any([stop.signal, AbortSignal.timeout(5000)])); } catch { /* Exact pending transmission remains durable. */ }
				await matrixDelay(1000, stop.signal).catch(() => {});
			}
		})();
		while (!stop.signal.aborted) {
			try {
				const batch = await matrix.sync(fresh ? "" : store.get("cursor"), [config.ownerUserId, ...config.remoteOwnerUserIds], store.pending(), stop.signal, !!accounts);
				accounts?.ingest(batch, fresh);
				const dropped = store.ingest(batch, config, Date.now(), fresh);
				store.atomic(() => store.put("identity", fingerprint));
				if (fresh) console.log('{"event":"watermark_initialized"}');
				fresh = false;
				if (dropped) console.log(JSON.stringify({ event: "queue_saturated", dropped }));
			} catch {
				accounts?.suspend();
				if (stop.signal.aborted) break;
				console.log('{"event":"sync_unavailable"}');
				await matrixDelay(5000, stop.signal).catch(() => {}); continue;
			}
			await store.step(matrix, (q, workspace) => modelAnswer(config.modelSocket, q, stop.signal, workspace, !!config.filesDirectory), config, Date.now, stop.signal);
		}
	} finally { stop.abort(); await accountTask; accountStore?.close(); store.close(); }
}
void main().catch(error => { console.error(transportFailure(stage, error)); process.exitCode = 1; });
