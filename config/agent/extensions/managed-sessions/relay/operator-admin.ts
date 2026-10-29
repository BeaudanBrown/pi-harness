import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { AtomicJsonFile } from "./atomic-json.js";
import { HostControlError } from "./host-control-error.js";
import type { RelayRegistry } from "./registry.js";
import { hasMatrixBinding } from "../contracts.js";

export interface AdminRoom { roomId: string; space: boolean }
export interface AdminPowerSnapshot extends AdminRoom {
	operatorUserId: string; botUserId: string; roomVersion: string; operatorMembership?: "join" | "invite";
	powers: Record<string, unknown>; proposed: Record<string, unknown>; change: boolean;
}
const conflict = (text: string) => new HostControlError("conflict", text);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function level(value: unknown, fallback: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value)) throw conflict("Room power levels must be bounded integers");
	return value;
}

/** Pure power edit. No guessed defaults for malformed maps and no member demotion. */
export function planOperatorAdmin(input: AdminRoom & { operatorUserId: string; botUserId: string; creation: Record<string, unknown>; powers: unknown }): AdminPowerSnapshot {
	const { powers, creation, operatorUserId, botUserId } = input;
	if (!object(powers) || Buffer.byteLength(JSON.stringify(powers)) > 16384 || operatorUserId === botUserId) throw conflict("Invalid or oversized room administration state");
	const roomVersion = creation.room_version === undefined ? "1" : creation.room_version;
	if (typeof roomVersion !== "string" || !/^(?:[1-9]|1[0-2])$/.test(roomVersion)) throw conflict("Unsupported room version for admin migration");
	const users = powers.users === undefined ? {} : powers.users;
	const events = powers.events === undefined ? {} : powers.events;
	if (!object(users) || !object(events)) throw conflict("Malformed room power maps");
	for (const value of [...Object.values(users), ...Object.values(events)]) level(value, 0);
	const usersDefault = level(powers.users_default, 0); const stateDefault = level(powers.state_default, 50);
	const threshold = Math.max(stateDefault, level(events["m.room.power_levels"], stateDefault), level(powers.kick, 50), level(powers.ban, 50), level(powers.invite, 0), level(powers.redact, 50));
	if (threshold > 100) throw conflict("Room administration requires nonstandard power above 100; investigate before migration");
	const creators = new Set<string>();
	if (roomVersion === "12") {
		creators.add(botUserId); // Caller must first prove original create-event sender.
		if (creation.additional_creators !== undefined && (!Array.isArray(creation.additional_creators) || creation.additional_creators.some(value => typeof value !== "string"))) throw conflict("Malformed room creator identities");
		for (const id of creation.additional_creators as string[] ?? []) creators.add(id);
		if ([...creators].some(id => Object.hasOwn(users, id))) throw conflict("Immutable room creators must not appear in power users");
	}
	const current = creators.has(operatorUserId) ? Infinity : level(users[operatorUserId], usersDefault);
	const proposed = structuredClone(powers);
	const change = current < 100;
	if (change) {
		const bot = creators.has(botUserId) ? Infinity : level(users[botUserId], usersDefault);
		if (bot < 100 || bot < level(events["m.room.power_levels"], stateDefault) || bot <= current) throw conflict("Owning bot cannot grant operator admin power");
		if (Object.entries(users).some(([id, value]) => id !== botUserId && id !== operatorUserId && level(value, 0) >= 100)) throw conflict("Another member already has admin power; review peer-admin authority before migration");
		proposed.users = { ...users, [operatorUserId]: 100 };
	}
	return { roomId: input.roomId, space: input.space, operatorUserId, botUserId, roomVersion, powers: structuredClone(powers), proposed, change };
}

export interface AdminSelection { conversationIds: string[]; includeSpaces?: true }
export interface AdminMigrationSnapshot { selection: AdminSelection; rooms: AdminPowerSnapshot[] }
export interface AdminMatrix {
	operatorAdminSnapshot(target: AdminRoom): Promise<AdminPowerSnapshot>;
	applyOperatorAdmin(snapshot: AdminPowerSnapshot, revalidateScope?: () => void): Promise<void>;
}

export class OperatorAdminMigration {
	private applying = false;
	constructor(private readonly options: { registry: RelayRegistry; matrix: AdminMatrix; directory: string }) {}
	private targets(selection: AdminSelection): AdminRoom[] {
		const rooms = new Map<string, boolean>();
		const add = (id: string | undefined, space: boolean) => {
			if (!id) return;
			if (rooms.has(id) && rooms.get(id) !== space) throw conflict("Room type references disagree");
			rooms.set(id, space);
		};
		for (const id of selection.conversationIds) {
			if (this.options.registry.retirement(id)) throw conflict("Retired conversations are outside admin migration scope");
			const manifest = this.options.registry.registeredConversation(id);
			if (!manifest) throw conflict("Selected conversation no longer exists");
			const binding = hasMatrixBinding(manifest) ? manifest : manifest.verifiedBinding;
			if (!binding) throw conflict("Selected conversation has no verified Matrix binding");
			add(binding.roomId, false);
			if (selection.includeSpaces) {
				add(binding.projectSpace, true); add(binding.checkoutSpace, true);
				if ("hostSpace" in binding) add(binding.hostSpace, true);
			}
		}
		if (rooms.size > 100) throw conflict("Too many admin targets; select fewer conversations");
		return [...rooms].sort(([a], [b]) => a.localeCompare(b)).map(([roomId, space]) => ({ roomId, space }));
	}
	async preview(selection: AdminSelection): Promise<AdminMigrationSnapshot> {
		const rooms: AdminPowerSnapshot[] = [];
		for (const target of this.targets(selection)) rooms.push(await this.options.matrix.operatorAdminSnapshot(target));
		return { selection: structuredClone(selection), rooms };
	}
	async apply(snapshot: AdminMigrationSnapshot, operationId: string): Promise<void> {
		if (this.applying) throw new HostControlError("busy", "Another room-admin migration is active");
		if (!/^operation_[a-f0-9]{32}$/.test(operationId)) throw conflict("Invalid admin migration identity");
		this.applying = true;
		try {
			if (!isDeepStrictEqual(await this.preview(snapshot.selection), snapshot)) throw new HostControlError("stale_preview", "Room permissions or targets changed; obtain a new preview and consent");
			const file = new AtomicJsonFile(join(this.options.directory, `${operationId}.json`), value => value);
			const completed: string[] = [];
			for (const room of snapshot.rooms) {
				if (!isDeepStrictEqual(this.targets(snapshot.selection), snapshot.rooms.map(({ roomId, space }) => ({ roomId, space })))) throw conflict("Admin migration scope changed; no further writes are authorized");
				if (!room.change) { completed.push(room.roomId); continue; }
				await file.write({ version: 1, operationId, snapshot, completed, attemptedRoom: room.roomId, phase: "attempted" });
				// Any uncertain outcome stops here. No startup/retry worker consumes receipts.
				await this.options.matrix.applyOperatorAdmin(room, () => {
					if (!isDeepStrictEqual(this.targets(snapshot.selection), snapshot.rooms.map(({ roomId, space }) => ({ roomId, space })))) throw conflict("Admin migration scope changed before write");
				});
				completed.push(room.roomId);
				await file.write({ version: 1, operationId, snapshot, completed, phase: "verified" });
			}
		} finally { this.applying = false; }
	}
}
