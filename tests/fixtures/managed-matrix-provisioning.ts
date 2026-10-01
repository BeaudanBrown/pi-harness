type Json = Record<string, any>;
export interface ProvisioningFixtureState { rooms: string[]; createCalls: number; inaccessibleRoom?: string }

/** Stateful Matrix boundary: aliases and initial state survive client/relay restarts. */
export function provisioningFixture(botUserId: string, state: ProvisioningFixtureState, beforeCreate: () => Promise<void> = async () => {}) {
	const aliases = new Map<string, string>(); const rooms = new Map<string, Json>();
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response | undefined> => {
		const path = new URL(String(input)).pathname;
		if (path.includes("/directory/room/")) {
			const alias = decodeURIComponent(path.split("/directory/room/")[1]!).slice(1).split(":")[0]!;
			const room = aliases.get(alias);
			return room ? Response.json({ room_id: room }) : Response.json({ errcode: "M_NOT_FOUND" }, { status: 404 });
		}
		if (path.endsWith("/createRoom")) {
			await beforeCreate(); const body = JSON.parse(String(init?.body)) as Json;
			if (aliases.has(body.room_alias_name)) return Response.json({ errcode: "M_ROOM_IN_USE" }, { status: 400 });
			const room = state.rooms.shift(); if (!room) throw Error("Unexpected room creation");
			state.createCalls++; rooms.set(room, body);
			if (body.room_alias_name) aliases.set(body.room_alias_name, room);
			return Response.json({ room_id: room });
		}
		const match = path.match(/\/rooms\/([^/]+)\/state(?:\/(.*))?$/);
		if (!match) return undefined;
		const room = decodeURIComponent(match[1]!); const body = rooms.get(room);
		if (state.inaccessibleRoom === room) return Response.json({ errcode: "M_FORBIDDEN" }, { status: 403 });
		if (!body) return undefined;
		const create = { creator: botUserId, ...body.creation_content };
		if (match[2] === "m.room.create/") return Response.json(create);
		if (match[2] === "m.room.power_levels/") return Response.json({ users: { [botUserId]: 100 } });
		if (match[2]?.startsWith("m.room.member/")) return Response.json({ membership: "join" });
		if (match[2] === undefined) return Response.json([
			{ type: "m.room.create", state_key: "", sender: botUserId, content: create },
			{ type: "m.room.join_rules", state_key: "", sender: botUserId, content: { join_rule: "invite" } },
			...(body.initial_state ?? []).map((event: Json) => ({ ...event, sender: botUserId })),
		]);
		return undefined;
	};
}
