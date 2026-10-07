import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join, basename, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { readFile, readdir, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

const env = process.env;
const sdkEntry = env.PI_HARNESS_NATIVE_SDK;
const sdk = await import(pathToFileURL(sdkEntry).href);
const require = createRequire(sdkEntry);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { tryNative: false });
const local = name => jiti.import(join(dirname(fileURLToPath(import.meta.url)), name));
const { classifyLaunchMode } = await local("mode.ts");
const { assertBasicManagedInvocation, resolveBasicSessionSelection } = await local("arguments.ts");
const { inspectSavedHistory, resolveNativeSessionPath } = await local("history.ts");
const { assertLocalHistory, assertLocalStorage, isOwnedSessionPath } = await local("local-guard.ts");
const { prepareImportedHistory } = await local("import-history.ts");
const { beginLaunchAttempt } = await local("attempt.ts");
const { requestHostControl } = await local("../relay/host-control-client.ts");
const { deriveConversationId, deriveGenerationId } = await local("../contracts.ts");
const { savedSessionKey, parseHostAction } = await local("../live-workspace-contracts.ts");

function native(argv, localOnly) {
	const next = { ...env, PI_HARNESS_LOCAL_SESSION_ROOT: env.PI_MANAGED_PROJECT_SESSION_DIR ?? "" };
	for (const key of Object.keys(next)) if (key.startsWith("PI_HARNESS_NATIVE_") || key.startsWith("PI_HARNESS_MANAGED_") || key === "PI_MANAGED_PROJECT_SESSION_DIR" || key === "PI_MANAGED_SESSIONS_WORKSPACE_ROOTS" || key === "PI_HARNESS_RESUME_FZF") delete next[key];
	if (localOnly) {
		for (const key of Object.keys(next)) if (key.startsWith("PI_MANAGED_") || key.startsWith("PI_MATRIX_") || key.startsWith("PI_BRIDGE_CHAT_") || key === "PI_HARNESS_AGENT_PROFILE") delete next[key];
		next.PI_HARNESS_LOCAL_ONLY = "1";
	}
	if (typeof process.execve !== "function") throw new Error("This launcher requires Node with execve support");
	process.execve(env.PI_HARNESS_NATIVE_PI, [env.PI_HARNESS_NATIVE_PI, ...argv], next);
}
function invoke(operation, request, terminal = false) {
	const childEnv = { ...env, TMUX_TMPDIR: env.XDG_RUNTIME_DIR }; delete childEnv.TMUX;
	const result = spawnSync(env.PI_HARNESS_MANAGED_LAUNCHER, ["managed", operation], {
		env: childEnv, input: JSON.stringify(request) + "\n", encoding: "utf8", maxBuffer: 65536,
		...(terminal ? { stdio: ["pipe", "inherit", "inherit"] } : { timeout: 15000 }),
	});
	if (result.error || result.status !== 0) throw new Error(`Managed ${operation} refused${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
	return terminal ? undefined : JSON.parse(result.stdout);
}
async function host(action, timeoutMs) {
	if (!env.XDG_RUNTIME_DIR) throw new Error("Managed host runtime is unavailable");
	return requestHostControl({ socketPath: join(env.XDG_RUNTIME_DIR, "pi-managed-sessions/control.sock"), action, requestId: randomUUID(), ...(timeoutMs ? { timeoutMs } : {}) });
}
function need(response) {
	if (!response.ok) throw new Error(`${response.error.message}; use pi-local-only for a separate local session`);
	return response.data;
}
function selectedArg(argv, parsed, property, path) {
	if (parsed[property] === path) return argv;
	const flag = property === "fork" ? "--fork" : "--session";
	for (const at of [argv.length, ...argv.flatMap((arg, index) => arg === "--" ? [index] : [])]) {
		const proposed = [...argv.slice(0, at), flag, path, ...argv.slice(at)];
		if (isDeepStrictEqual(sdk.parseArgs(proposed), { ...parsed, [property]: path })) return proposed;
	}
	throw new Error("Cannot preserve native arguments while selecting history; use an explicit session path");
}
async function picker(rows) {
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Session selection requires an interactive terminal");
	if (!rows.length) return undefined;
	const clean = value => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 200);
	const result = spawnSync(env.PI_HARNESS_RESUME_FZF, ["--read0", "--print0", "--delimiter=\t", "--with-nth=2..", "--prompt=Resume> "], {
		input: rows.map((row, index) => `${index}\t${clean(row.name || row.firstMessage || row.id)}\t${clean(row.cwd)}\0`).join(""),
		encoding: "utf8", maxBuffer: 65536, stdio: ["pipe", "pipe", "inherit"], env: { ...env, FZF_DEFAULT_OPTS: "", FZF_DEFAULT_OPTS_FILE: "/dev/null" },
	});
	if (result.status === 1 || result.status === 130) return undefined;
	if (result.error || result.status !== 0) throw new Error("Saved-session picker failed");
	const index = Number(result.stdout.split("\t", 1)[0]);
	if (!Number.isInteger(index) || !rows[index]) throw new Error("Invalid saved-session selection");
	return rows[index].path;
}
async function run() {
	const argv = process.argv.slice(2), parsed = sdk.parseArgs(argv), cwd = process.cwd();
	const localOnly = env.PI_HARNESS_LOCAL_ONLY === "1";
	const mode = classifyLaunchMode(argv, parsed, { configured: Boolean(env.PI_HARNESS_MANAGED_LAUNCHER), localOnly,
		stdinIsTTY: Boolean(process.stdin.isTTY), stdoutIsTTY: Boolean(process.stdout.isTTY), trustedDispatch: false,
		internalWorker: Boolean(env.PI_ALOOP_INVOCATION_ID || env.PI_EVAL_ATTESTATION_PATH), profile: env.PI_HARNESS_AGENT_PROFILE,
		experimentsEnabled: env.PI_EXPERIMENTAL === "1" || env.PI_HARNESS_ENABLE_PI_R === "1" || env.PI_HARNESS_ENABLE_AGENTGRAPH === "1" });
	if (mode.kind === "native" && ["command", "diagnostic", "ephemeral"].includes(mode.reason)) return native(argv, localOnly);
	if (parsed.noSession || parsed.help || parsed.version || parsed.export || parsed.listModels !== undefined) return native(argv, localOnly);
	const settings = sdk.SettingsManager.fromStorage({ withLock(scope, fn) {
		let text; try { text = readFileSync(scope === "global" ? join(sdk.getAgentDir(), "settings.json") : join(cwd, ".pi/settings.json"), "utf8"); }
		catch (error) { if (error.code !== "ENOENT") throw error; }
		fn(text); // Read-only storage: never publish settings migrations during admission.
	} });
	const directory = parsed.sessionDir || env.PI_CODING_AGENT_SESSION_DIR || settings.getSessionDir();
	const checkStorage = () => assertLocalStorage(resolveNativeSessionPath(directory ?? join(sdk.getAgentDir(), "sessions"), cwd), env.PI_MANAGED_PROJECT_SESSION_DIR, directory === undefined);
	const selectionArgs = Object.fromEntries(["continue", "resume", "session", "sessionId"].filter(key => parsed[key] !== undefined).map(key => [key, parsed[key]]));
	if (parsed.fork !== undefined) selectionArgs.session = parsed.fork;
	if (directory !== undefined && Object.keys(selectionArgs).length) selectionArgs.sessionDir = directory;
	Object.assign(selectionArgs, { messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [] });
	const lists = {
		async listAll(custom) {
			const rows = await sdk.SessionManager.listAll(custom);
			if (mode.kind === "candidate" && env.PI_MANAGED_PROJECT_SESSION_DIR) {
				let children = []; try { children = await readdir(env.PI_MANAGED_PROJECT_SESSION_DIR, { withFileTypes: true }); } catch (error) { if (error.code !== "ENOENT") throw error; }
				if (children.length > 4096) throw new Error("Managed session inventory too large; select an explicit file");
				for (const child of children) if (child.isDirectory() && /^conv_[a-f0-9]{32}$/.test(child.name)) rows.push(...await sdk.SessionManager.listAll(join(env.PI_MANAGED_PROJECT_SESSION_DIR, child.name)));
			}
			return [...new Map(rows.map(row => [row.path, row])).values()].sort((a, b) => Number(b.modified) - Number(a.modified));
		},
		async list(current, custom) { return (await this.listAll(custom)).filter(row => row.cwd === current); },
	};
	const selection = await resolveBasicSessionSelection(selectionArgs, cwd, lists, resolveNativeSessionPath, { allowMissingSessionId: true });
	let path = selection.kind === "saved" ? selection.path : selection.kind === "picker" ? await picker(selection.candidates) : undefined;
	if (selection.kind === "picker" && !path) return 0;
	let inspection, text, missingHistory = false;
	if (path) {
		try {
			if (await realpath(path) !== resolve(path)) throw new Error("Select canonical, non-symlink saved history");
			text = await readFile(path, "utf8"); inspection = inspectSavedHistory(text, sdk.parseSessionEntries, sdk.CURRENT_SESSION_VERSION);
		} catch (error) { if (error.code !== "ENOENT") throw error; missingHistory = true; }
	}
	if (mode.kind !== "candidate") {
		await checkStorage();
		if (path && !parsed.fork) await assertLocalHistory(path, sdk, env.PI_MANAGED_PROJECT_SESSION_DIR, true);
		return native(path && parsed.sessionId === undefined ? selectedArg(argv, parsed, parsed.fork ? "fork" : "session", path) : argv, localOnly);
	}
	const targetCwd = parsed.fork ? cwd : inspection?.cwd ?? cwd;
	const workspace = invoke("workspace-identify-auto", { cwd: targetCwd });
	if (!workspace.eligible) {
		await checkStorage();
		if (path && !parsed.fork) await assertLocalHistory(path, sdk, env.PI_MANAGED_PROJECT_SESSION_DIR, true);
		console.error(`pi: local launch (${workspace.reason})`);
		return native(path && parsed.sessionId === undefined ? selectedArg(argv, parsed, parsed.fork ? "fork" : "session", path) : argv, false);
	}
	assertBasicManagedInvocation(parsed);
	if (missingHistory) throw new Error("Saved history was not found; no managed launch was admitted");
	if (parsed.sessionId !== undefined && selection.kind === "fresh") throw new Error("Managed --session-id must select existing history; omit it for a fresh conversation");
	const ui = invoke("ui-capabilities", {});
	if (ui.version !== 1 || ui.clientCapture !== true || ui.exactFocus !== true || ui.exactAttach !== true) throw new Error("Managed launcher requires an upgrade before admission");
	const status = need(await host({ operation: "host.status" }));
	if (status.hostId !== env.PI_HARNESS_MANAGED_HOST_ID || (!status.capabilities.includes("saved-session-open-v1") || !status.capabilities.includes("window-first-open-v1"))) throw new Error("Managed host identity/capability changed; upgrade or recover explicitly");
	let conversationId, generation, authority = "unregistered";
	if (inspection && !inspection.managedMarkers && !isOwnedSessionPath(path, env.PI_MANAGED_PROJECT_SESSION_DIR)) {
		let cursor, count = 0, pages = 0; const cursors = new Set();
		do {
			const page = need(await host({ operation: "conversation.list", ...(cursor ? { cursor } : {}) }));
			count += page.items.length;
			if (++pages > 128 || count > 4096 || (page.nextCursor && cursors.has(page.nextCursor))) throw new Error("Host ownership inventory is incomplete or too large");
			if (page.items.some(item => item.sessionKey === savedSessionKey(status.hostId, inspection.sessionId))) throw new Error("Managed identity has no matching source boundary; use its host conversation instead");
			cursor = page.nextCursor; if (cursor) cursors.add(cursor);
		} while (cursor);
	}
	if (inspection?.managedMarkers || (path && isOwnedSessionPath(path, env.PI_MANAGED_PROJECT_SESSION_DIR))) {
		const boundaries = sdk.parseSessionEntries(text).filter(entry => entry.type === "custom" && entry.customType === "managed-session.binding-boundary" && entry.data?.sessionId === inspection.sessionId);
		if (boundaries.length !== 1 || boundaries[0].data.version !== "1.0.0" || typeof boundaries[0].data.creationKey !== "string") throw new Error("Saved history ownership is ambiguous; explicit recovery required");
		const data = boundaries[0].data, ordinal = data.ordinal ?? 1;
		conversationId = deriveConversationId(status.hostId, data.creationKey);
		if (!Number.isSafeInteger(ordinal) || ordinal < 1 || resolve(path) !== join(env.PI_MANAGED_PROJECT_SESSION_DIR, conversationId, ordinal === 1 ? "session.jsonl" : `generation-${ordinal}.jsonl`)) throw new Error("Saved history is outside its host-owned generation path");
		generation = deriveGenerationId(conversationId, ordinal);
		const response = await host({ operation: "conversation.status", conversationId });
		if (!response.ok && response.error.code === "retired") { authority = "retired"; conversationId = undefined; generation = undefined; }
		else { const existing = need(response); if (existing.sessionKey !== savedSessionKey(status.hostId, inspection.sessionId) || existing.activeGenerationId !== generation) throw new Error("Historical generation cannot replace the current managed writer"); }
	}
	let client, attempt;
	if (env.TMUX) {
		const parts = env.TMUX.split(","); const server = parts.at(-2);
		const captured = invoke("client-capture", { paneId: env.TMUX_PANE, sourceServerPid: server, ...(env.TMUX_PROJECT_CLIENT ? { clientName: env.TMUX_PROJECT_CLIENT } : {}) });
		if (typeof captured.clientName !== "string" || !captured.clientName || typeof captured.clientPid !== "string" || !/^[1-9][0-9]*$/.test(captured.clientPid)) throw new Error("Invalid captured requesting client");
		client = { clientName: captured.clientName, clientPid: captured.clientPid };
	}
	if (!conversationId) {
		const creationKey = `local-${randomUUID()}`, concept = basename(targetCwd).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0,128).toWellFormed().trim() || "Conversation";
		let action = parseHostAction({ operation: "conversation.create", creationKey, title: concept, placement: workspace.placement });
		conversationId = deriveConversationId(status.hostId, creationKey);
		generation = deriveGenerationId(conversationId, 1);
		if (path && !status.capabilities.includes("saved-session-import-v1")) throw new Error("Host does not support fenced history import; upgrade before resuming");
		attempt = await beginLaunchAttempt(join(env.PI_MANAGED_PROJECT_SESSION_DIR, ".launch-attempts"), status.hostId, action, path ? { path, sessionId: inspection.sessionId } : undefined);
		console.error(`pi: launch ${conversationId}; interrupted-attempt record: ${attempt.path}`);
		if (path) {
			const imported = await prepareImportedHistory({ source: path, destination: join(env.PI_MANAGED_PROJECT_SESSION_DIR, conversationId, "session.jsonl"), cwd: targetCwd, conversationId, creationKey, concept, authority, expectedSessionId: inspection.sessionId }, sdk);
			action = parseHostAction({ ...action, expectedSessionKey: savedSessionKey(status.hostId, imported.sessionId) });
		}
		// Start once, then join its window-first open. Disconnect never cancels or
		// replays this accepted creation, including an uncertain acknowledgement.
		await attempt.ready(action);
		let completion;
		void host(action).then(value => { completion = value; });
		const deadline = Date.now() + 30_000;
		for (;;) {
			if (Date.now() >= deadline) throw new Error(`Creation outcome unknown for ${conversationId}; inspect host inventory before retrying`);
			const observed = await host({ operation: "conversation.status", conversationId }, Math.max(1, Math.min(30_000, deadline - Date.now())));
			if (observed.ok) {
				if (observed.data.activeGenerationId !== generation || (action.expectedSessionKey && observed.data.sessionKey !== action.expectedSessionKey)) throw new Error(`Imported identity changed for ${conversationId}; inspect the host before retrying`);
				break;
			}
			if (completion && !completion.ok) need(completion);
			if (observed.error.code !== "not_found") need(observed);
			await new Promise(done => setTimeout(done,100));
		}
	}
	const opened = need(await host({ operation: "conversation.open", conversationId, ...(generation ? { expectedGenerationId: generation } : {}) }));
	if (opened.conversationId !== conversationId || opened.window.conversationId !== conversationId) throw new Error("Opened target identity changed; inspect the host before retrying");
	if (attempt) await attempt.complete().catch(() => console.error("pi: host admission confirmed; recovery record needs manual cleanup"));
	const target = { ...opened.window, launchId: opened.launchId };
	if (client) invoke("window-focus-exact", { ...target, ...client });
	else invoke("window-attach-exact", target, true);
	return 0;
}
run().then(code => process.exit(code ?? 0), error => { console.error(`pi: ${error.message}${env.PI_HARNESS_LOCAL_ONLY === "1" ? "" : "; use pi-local-only for separate local work"}`); process.exit(1); });
