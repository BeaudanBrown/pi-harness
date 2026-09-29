import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveConversationId, MANAGED_SESSION_STATE_VERSION, type ConversationManifest } from "../config/agent/extensions/managed-sessions/contracts.js";
import { HostLifecycle } from "../config/agent/extensions/managed-sessions/relay/host-lifecycle.js";
import { ManagedSessionIpcServer } from "../config/agent/extensions/managed-sessions/relay/ipc-server.js";
import { ConversationManifestStore } from "../config/agent/extensions/managed-sessions/relay/manifest-store.js";
import { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";
import { ProjectSpaces, projectSpaceAlias } from "../config/agent/extensions/managed-sessions/relay/project-spaces.js";
import { RelayRegistry } from "../config/agent/extensions/managed-sessions/relay/registry.js";

const projectKey = `project_${"a".repeat(32)}`;
const legacyAlias = `pi-${"a".repeat(32)}-space`;
const placement = { rootKey: "projects", workspace: "todo-agent", relativeCwd: "" };
const resolved = { ...placement, workspacePath: "/shared/todo-agent", cwd: "/shared/todo-agent", projectKey,
	projectDisplayName: "todo-agent", checkoutDisplayName: "todo-agent" };

/** Two independent bot clients see one homeserver, including private foreign aliases. */
class Rooms {
	readonly aliases = new Map<string, string>();
	readonly rooms = new Map<string, { owner: string; space: boolean; children: Set<string>; power: number }>();
	readonly calls: Array<{ bot: string; method: string; path: string }> = [];
	failLink = false;
	failDirectory = false;
	publicPreviews = false;
	seed(alias: string, owner: string, space = true): string {
		const id = `!room${this.rooms.size + 1}:example.com`;
		this.rooms.set(id, { owner, space, children: new Set(), power: 100 }); this.aliases.set(alias, id); return id;
	}
	fetch(bot: string): typeof fetch {
		return async (input, init) => {
			const path = decodeURIComponent(new URL(String(input)).pathname); const method = init?.method ?? "GET";
			this.calls.push({ bot, method, path });
			if (path.includes("/directory/room/")) {
				if (this.failDirectory) return new Response("forbidden", { status: 403 });
				const alias = path.split("/directory/room/#")[1]!.split(":")[0]!;
				const id = this.aliases.get(alias); return id ? Response.json({ room_id: id }) : new Response("missing", { status: 404 });
			}
			if (path.endsWith("/createRoom")) {
				const body = JSON.parse(String(init?.body));
				if (this.aliases.has(body.room_alias_name)) return new Response("alias exists", { status: 400 });
				return Response.json({ room_id: this.seed(body.room_alias_name, bot, body.creation_content.type === "m.space") });
			}
			const roomId = path.split("/rooms/")[1]?.split("/")[0]; const room = roomId && this.rooms.get(roomId);
			if (!room) throw new Error(`Unexpected Matrix request: ${method} ${path}`);
			if (room.owner !== bot && !this.publicPreviews) return new Response("not joined", { status: 403 });
			if (path.endsWith("/state/m.room.create/")) return Response.json({ creator: room.owner, ...(room.space ? { type: "m.space" } : {}) });
			if (path.endsWith("/state/m.room.power_levels/")) return Response.json({ users: { [room.owner]: room.power } });
			if (path.includes("/state/m.room.member/")) return Response.json({ membership: room.owner === bot ? "join" : "leave" });
			if (method === "PUT" && path.includes("/state/m.space.child/")) {
				if (room.owner !== bot || room.power < 50) return new Response("forbidden", { status: 403 });
				if (this.failLink) return new Response("interrupted", { status: 503 });
				const child = path.split("/state/m.space.child/")[1]!;
				if (JSON.parse(String(init?.body)).via) room.children.add(child); else room.children.delete(child);
				return Response.json({ event_id: "$linked" });
			}
			throw new Error(`Unexpected Matrix request: ${method} ${path}`);
		};
	}
}

async function host(root: string, hostId: string, rooms: Rooms, binding?: string) {
	const bot = `@pi-${hostId}:example.com`; const sessions = join(root, "sessions");
	const store = new ConversationManifestStore(join(root, "manifests"));
	if (binding) {
		const manifest: ConversationManifest = { schemaVersion: MANAGED_SESSION_STATE_VERSION, kind: "project",
			conversationId: deriveConversationId(hostId, "existing"), ownerHostId: hostId, creationKey: "existing", concept: "existing",
			piSessionId: "existing-session", roomId: "!existing:example.com", bindingBoundaryEntryId: `entry_${"b".repeat(32)}`,
			createdAt: "2026-09-29T00:00:00.000Z", placement, projectKey, projectDisplayName: "todo-agent", checkoutDisplayName: "todo-agent", projectSpace: binding };
		await store.write(manifest);
	}
	const registry = new RelayRegistry(hostId, join(root, "runtime"), store); await registry.load();
	const matrix = new ManagedMatrixClient({ homeserver: "https://matrix.example.com", botUserId: bot, operatorUserId: "@operator:example.com", accessToken: "test-token" },
		rooms.fetch(bot), registry.managedRoomIds(), { maxAttempts: 1 });
	const server = new ManagedSessionIpcServer(registry, { runtimeDirectory: join(root, "ipc") });
	const lifecycle = new HostLifecycle({ hostId, launcher: "/unused-launcher", projectSessionDirectory: sessions, socketPath: server.socketPath, registry, matrix, server });
	const conversationId = deriveConversationId(hostId, "todo"); const intentPath = join(sessions, conversationId, "matrix-provisioning.json");
	const pending = async (extra: Record<string, unknown> = {}) => {
		await mkdir(join(sessions, conversationId), { recursive: true });
		await writeFile(intentPath, JSON.stringify({ conversationId, concept: "todo", projectKey, projectDisplayName: "todo-agent", checkoutDisplayName: "todo-agent", ...extra }), { mode: 0o600 });
	};
	return { bot, registry, matrix, lifecycle, pending, intentPath, provision: () => lifecycle.provisionConversationMatrix(conversationId, "todo", resolved) };
}

async function rootFor(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "project-spaces-")); t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test("shared workspace uses distinct host-owned Spaces and same-host retries reuse them", async (t) => {
	const root = await rootFor(t); const rooms = new Rooms();
	const nas = await host(join(root, "nas"), "nas", rooms); const grill = await host(join(root, "grill"), "grill", rooms);
	const [first, second] = await Promise.all([nas.provision(), grill.provision()]);
	assert.notEqual(first.projectSpace, second.projectSpace); assert.notEqual(first.roomId, second.roomId);
	assert.equal(rooms.aliases.get(projectSpaceAlias("nas", projectKey)), first.projectSpace);
	assert.equal(rooms.aliases.get(projectSpaceAlias("grill", projectKey)), second.projectSpace);
	assert.equal(rooms.aliases.has(legacyAlias), false);
	assert.deepEqual(await grill.provision(), second); assert.equal(rooms.rooms.size, 4);
	assert.notEqual(projectSpaceAlias("ab", "c"), projectSpaceAlias("a", "bc"), "inputs are length-framed");
});

test("NAS legacy binding survives while GRILL recovers an uncheckpointed foreign-alias failure", async (t) => {
	const root = await rootFor(t); const rooms = new Rooms(); const legacy = rooms.seed(legacyAlias, "@pi-nas:example.com");
	const nas = await host(join(root, "nas"), "nas", rooms, legacy);
	const grill = await host(join(root, "grill"), "grill", rooms); await grill.pending();
	const nasBinding = await nas.provision(); const grillBinding = await grill.provision();
	assert.equal(nasBinding.projectSpace, legacy); assert.notEqual(grillBinding.projectSpace, legacy);
	assert.equal(rooms.aliases.get(legacyAlias), legacy); assert.equal(rooms.rooms.get(legacy)!.owner, nas.bot);
	assert.deepEqual([...rooms.rooms.get(legacy)!.children], [nasBinding.roomId]);
	assert.equal(rooms.calls.some((call) => call.bot === grill.bot && call.method !== "GET" && call.path.includes(legacy)), false);
	assert.equal(rooms.calls.some((call) => call.path.endsWith("/join") || call.path.endsWith("/leave")), false);
});

test("foreign legacy creator with readable previews is not adopted", async (t) => {
	const root = await rootFor(t); const rooms = new Rooms(); rooms.publicPreviews = true;
	const legacy = rooms.seed(legacyAlias, "@pi-nas:example.com");
	const grill = await host(root, "grill", rooms); await grill.pending();
	assert.notEqual((await grill.provision()).projectSpace, legacy); assert.equal(rooms.rooms.get(legacy)!.children.size, 0);
});

test("lost legacy create response recovers the owned Space instead of duplicating it", async (t) => {
	const root = await rootFor(t); const rooms = new Rooms(); const legacy = rooms.seed(legacyAlias, "@pi-nas:example.com");
	const nas = await host(root, "nas", rooms); await nas.pending();
	assert.equal((await nas.provision()).projectSpace, legacy); assert.equal(rooms.rooms.size, 2);
	assert.equal(rooms.aliases.has(projectSpaceAlias("nas", projectKey)), false);
});

for (const legacy of [false, true]) test(`restart after room creation preserves checkpointed ${legacy ? "legacy" : "host-scoped"} Space and room`, async (t) => {
	const root = await rootFor(t); const rooms = new Rooms();
	if (legacy) rooms.seed(legacyAlias, "@pi-grill:example.com");
	const before = await host(root, "grill", rooms); if (legacy) await before.pending();
	rooms.failLink = true; await assert.rejects(before.provision, /Matrix PUT/);
	const checkpoint = JSON.parse(await readFile(before.intentPath, "utf8")); assert.ok(checkpoint.projectSpaceId); assert.ok(checkpoint.roomId);
	rooms.failLink = false; const after = await host(root, "grill", rooms);
	assert.deepEqual(await after.provision(), { projectSpace: checkpoint.projectSpaceId, roomId: checkpoint.roomId });
	assert.equal(rooms.rooms.size, 2); assert.equal(rooms.rooms.get(checkpoint.projectSpaceId)!.children.has(checkpoint.roomId), true);
});

test("bound and checkpointed foreign targets fail closed instead of silently replacing rooms", async (t) => {
	const root = await rootFor(t); const rooms = new Rooms(); const legacy = rooms.seed(legacyAlias, "@pi-nas:example.com");
	const grill = await host(join(root, "pending"), "grill", rooms); await grill.pending({ projectSpaceId: legacy });
	await assert.rejects(grill.provision, /Matrix GET/);
	const bound = await host(join(root, "bound"), "grill", rooms, legacy); await assert.rejects(bound.provision, /Matrix GET/);
	assert.equal(rooms.rooms.size, 1); assert.equal(rooms.calls.some((call) => call.method !== "GET"), false);
});

test("host-scoped alias authorization, directory errors, and owned legacy power failures are not hidden", async (t) => {
	const root = await rootFor(t); const rooms = new Rooms();
	const target = rooms.seed(projectSpaceAlias("grill", projectKey), "@foreign:example.com");
	const grill = await host(root, "grill", rooms); await grill.pending();
	await assert.rejects(grill.provision, /Matrix GET/); assert.equal(rooms.rooms.size, 1);
	rooms.aliases.delete(projectSpaceAlias("grill", projectKey)); rooms.rooms.delete(target);
	rooms.failDirectory = true; await assert.rejects(grill.provision, /Matrix GET/); rooms.failDirectory = false;
	const legacy = rooms.seed(legacyAlias, grill.bot); rooms.rooms.get(legacy)!.power = 0;
	await assert.rejects(grill.provision, /authority/); assert.equal(rooms.rooms.size, 1);
});

test("reconciliation target validation preserves bound legacy IDs without adopting a foreign global alias", async (t) => {
	const root = await rootFor(t); const rooms = new Rooms(); const legacy = rooms.seed(legacyAlias, "@pi-nas:example.com");
	const nas = await host(root, "nas", rooms, legacy);
	// An established binding is stronger than a later alias reassignment.
	rooms.seed(legacyAlias, "@pi-grill:example.com");
	const spaces = new ProjectSpaces(nas.registry, nas.matrix);
	assert.equal(await spaces.find(projectKey), legacy); await spaces.assertTarget(projectKey, legacy);
	assert.equal(rooms.calls.some((call) => call.path.includes("/directory/room/")), false);
});
