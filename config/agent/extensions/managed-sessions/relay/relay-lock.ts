import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { ensurePrivateDirectory } from "./atomic-json.js";

export async function hostRelayLockPath(hostId: string, uid: number | undefined): Promise<string> {
	const userKey = uid === undefined ? "unknown" : String(uid);
	const root = await ensurePrivateDirectory(join("/tmp", `pi-managed-session-locks-${userKey}`));
	const hostKey = createHash("sha256").update("pi-managed-sessions:host-lock:v1\0").update(hostId).digest("hex").slice(0, 32);
	return join(root, `${hostKey}.lock`);
}

export class HostRelayLock {
	private child?: ChildProcessWithoutNullStreams;

	constructor(private readonly helper: string, private readonly lockPath: string) {}

	async acquire(): Promise<void> {
		if (this.child) throw new Error("Host relay lock is already held");
		const child = spawn(this.helper, [this.lockPath], { stdio: ["pipe", "pipe", "pipe"] });
		this.child = child;
		try {
			await new Promise<void>((resolve, reject) => {
				let output = "";
				let settled = false;
				const finish = (error?: Error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					error ? reject(error) : resolve();
				};
				const timer = setTimeout(() => finish(new Error("Timed out acquiring the host relay lock")), 2_000);
				child.once("error", () => finish(new Error("Host relay lock helper failed")));
				child.once("close", () => finish(new Error("Another managed-session relay already owns this host")));
				child.stdout.setEncoding("utf8");
				child.stdout.on("data", (chunk: string) => {
					output += chunk;
					if (output === "locked\n") finish();
					else if (output.length >= 7) finish(new Error("Host relay lock helper returned an invalid response"));
				});
			});
		} catch (error) {
			this.child = undefined;
			child.kill();
			throw error;
		}
	}

	async release(): Promise<void> {
		const child = this.child;
		if (!child) return;
		this.child = undefined;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => { child.kill("SIGKILL"); }, 2_000);
			child.once("close", () => { clearTimeout(timer); resolve(); });
			child.stdin.end();
		});
	}
}
