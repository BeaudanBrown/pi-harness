import { spawn } from "node:child_process";

/** Decode without rewriting: size and digest always describe the original bytes. */
export async function validateImageDecode(bytes: Buffer, mimeType: string, executable = process.env.PI_MANAGED_SESSIONS_IMAGE_NORMALIZER): Promise<void> {
	if (!executable?.startsWith("/")) throw new Error("Bounded image decoder is unavailable");
	const coder = ({ "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" } as Record<string, string>)[mimeType];
	if (!coder) throw new Error("Image type is unsupported");
	await new Promise<void>((resolve, reject) => {
		const child = spawn(executable, ["-regard-warnings", "-limit", "memory", "256MiB", "-limit", "map", "256MiB",
			"-limit", "disk", "0", "-limit", "width", "16384", "-limit", "height", "16384", "-limit", "list-length", "128",
			`${coder}:-`, "null:"], { stdio: ["pipe", "ignore", "ignore"], env: { PATH: "", MAGICK_THREAD_LIMIT: "1" } });
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000); timer.unref();
		child.stdin.on("error", () => undefined); // A decoder rejection can close stdin early.
		child.once("error", () => { clearTimeout(timer); reject(new Error("Image decoding failed")); });
		child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Image decoding failed")); });
		child.stdin.end(bytes);
	});
}
