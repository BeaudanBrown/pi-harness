import assert from "node:assert/strict";
import test from "node:test";
import { deriveCheckoutId, managedRoomAlias, parseManagedProvenance, safeManagedTitle, MANAGED_PROVENANCE_EVENT, type ManagedProvenance } from "../config/agent/extensions/managed-sessions/managed-provenance.js";
import { ManagedMatrixClient } from "../config/agent/extensions/managed-sessions/relay/matrix-client.js";

const config = { homeserver: "https://matrix.example.com", botUserId: "@bot:example.com", operatorUserId: "@owner:example.com", accessToken: "test-only" };
const projectKey = `project_${"a".repeat(32)}`;
const proof: ManagedProvenance = { version: 1, hostId: "host-a", kind: "worktree_space", creationKey: "checkout-main",
	projectKey, checkoutId: deriveCheckoutId("host-a", projectKey, "/projects/repository"), parentRoomId: "!project:example.com" };

function matrixFixture(options: { exists?: boolean; loseCreateResponse?: boolean; proof?: unknown; sender?: string; encrypted?: boolean; public?: boolean } = {}) {
	let exists = options.exists ?? false;
	const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
	const roomId = "!managed:example.com";
	const create = { creator: config.botUserId, type: "m.space", "m.federate": false };
	const client = new ManagedMatrixClient(config, async (input, init) => {
		const url = new URL(String(input)).pathname;
		if (url.includes("/directory/room/")) return exists ? Response.json({ room_id: roomId }) : Response.json({ errcode: "M_NOT_FOUND" }, { status: 404 });
		if (url.endsWith("/createRoom")) {
			writes.push({ url, body: JSON.parse(String(init?.body)) }); exists = true;
			if (options.loseCreateResponse) throw Error("accepted before response lost");
			return Response.json({ room_id: roomId });
		}
		if (url.endsWith("/state/m.room.create/")) return Response.json(create);
		if (url.endsWith("/state/m.room.power_levels/")) return Response.json({ users: { [config.botUserId]: 100 } });
		if (url.includes("/state/m.room.member/")) return Response.json({ membership: "join" });
		if (url.endsWith("/state")) return Response.json([
			{ type: "m.room.create", state_key: "", sender: config.botUserId, content: create },
			{ type: "m.room.join_rules", state_key: "", sender: config.botUserId, content: { join_rule: options.public ? "public" : "invite" } },
			{ type: MANAGED_PROVENANCE_EVENT, state_key: "", sender: options.sender ?? config.botUserId, content: options.proof ?? proof },
			...(options.encrypted ? [{ type: "m.room.encryption", state_key: "", sender: config.botUserId, content: { algorithm: "m.megolm.v1.aes-sha2" } }] : []),
		]);
		throw Error(`Unexpected request: ${url}`);
	}, [], { maxAttempts: 1 });
	return { client, writes, roomId };
}

test("checkout and alias identities exclude mutable display and parent attributes", () => {
	assert.notEqual(deriveCheckoutId("host-a", projectKey, "/projects/repository"), deriveCheckoutId("host-a", projectKey, "/projects/repository-feature"));
	assert.notEqual(deriveCheckoutId("host-a", projectKey, "/projects/repository"), deriveCheckoutId("host-b", projectKey, "/projects/repository"));
	assert.equal(managedRoomAlias(proof), managedRoomAlias({ ...proof, parentRoomId: "!new-parent:example.com" }));
	assert.notEqual(managedRoomAlias(proof), managedRoomAlias({ ...proof, hostId: "host-b" }));
	assert.throws(() => deriveCheckoutId("host-a", projectKey, "/projects/../repository"), /canonical/);
	assert.throws(() => deriveCheckoutId("host-a", projectKey, "/projects/repository/"), /canonical/);
	assert.throws(() => parseManagedProvenance({ ...proof, accessToken: "no" }), /provenance/);
	assert.throws(() => parseManagedProvenance({ ...proof, workspacePath: "/private/path" }), /provenance/);
	assert.equal(safeManagedTitle("\u202e\u0000", proof.checkoutId), `conversation ${proof.checkoutId.slice(-32)}`);
	assert.equal(safeManagedTitle("  Safe\n\u202e title  ", proof.checkoutId), "Safe title");
	assert.equal(Array.from(safeManagedTitle("😀".repeat(150), proof.checkoutId)).length, 80);
});

test("lost create response resolves the same proven alias without creating a duplicate", async () => {
	const { client, writes, roomId } = matrixFixture({ loseCreateResponse: true });
	assert.equal(await client.ensureManagedRoom("Worktree", proof), roomId);
	assert.equal(await client.ensureManagedRoom("Renamed title is not identity", proof), roomId);
	assert.equal(writes.length, 1);
	assert.deepEqual(writes[0]!.body.initial_state, [{ type: MANAGED_PROVENANCE_EVENT, state_key: "", content: proof }]);
	assert.equal(writes[0]!.body.room_alias_name, managedRoomAlias(proof));
	assert.deepEqual(writes[0]!.body.invite, [config.operatorUserId]);
});

test("same-bot foreign aliases, forged management state and encrypted targets are never adopted", async () => {
	for (const options of [{ proof: { ...proof, hostId: "other-host" } }, { sender: "@foreign:example.com" }, { encrypted: true }, { public: true }, { proof: {} }, { proof: { ...proof, parentRoomId: "!other:example.com" } }]) {
		const { client, writes } = matrixFixture({ exists: true, ...options });
		await assert.rejects(() => client.ensureManagedRoom("Same name", proof), /foreign, contradictory, or encrypted/);
		assert.equal(writes.length, 0, "foreign aliases are read-only failures, never overwritten");
	}
});
