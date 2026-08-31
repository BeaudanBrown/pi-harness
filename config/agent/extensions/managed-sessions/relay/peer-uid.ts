import { spawn } from "node:child_process";
import type { Socket } from "node:net";

export function peerUidFromHelper(helper: string, socket: Socket): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(helper, [], { stdio: ["ignore", "pipe", "ignore", socket] });
		let output = "";
		const stdout = child.stdout;
		if (!stdout) {
			reject(new Error("Peer credential verification helper produced no output"));
			return;
		}
		stdout.setEncoding("utf8");
		stdout.on("data", (chunk: string) => {
			output += chunk;
			if (output.length > 32) child.kill();
		});
		child.once("error", () => reject(new Error("Peer credential verification helper failed")));
		child.once("close", (code) => {
			const value = Number(output.trim());
			if (code !== 0 || !Number.isSafeInteger(value) || value < 0) {
				reject(new Error("Peer credential verification was unavailable"));
				return;
			}
			resolve(value);
		});
	});
}
