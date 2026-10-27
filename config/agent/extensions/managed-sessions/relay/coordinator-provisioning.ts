import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { MatrixRoomIdSchema } from "../../matrix-shared/room-id.js";
import { deriveConversationId } from "../contracts.js";
import type { ManagedProvenance } from "../managed-provenance.js";
import { AtomicJsonFile } from "./atomic-json.js";
import { ManagedMatrixClient, ManagedMatrixError } from "./matrix-client.js";

const room = MatrixRoomIdSchema;
const Schema = Type.Object({ version: Type.Literal(1), hostId: Type.String({ minLength: 1, maxLength: 128 }),
	conversationId: Type.String({ pattern: "^conv_[a-f0-9]{32}$" }),
	hostAttempted: Type.Boolean(), roomAttempted: Type.Boolean(), linked: Type.Boolean(),
	hostSpace: Type.Optional(room), roomId: Type.Optional(room),
}, { additionalProperties: false });
type Intent = Static<typeof Schema>;
function parse(value: unknown): Intent {
	if (!Check(Schema, value) || value.conversationId !== deriveConversationId(value.hostId, "coordinator") ||
		(value.hostSpace !== undefined && !value.hostAttempted) || (value.roomAttempted && !value.hostSpace) ||
		(value.roomId !== undefined && !value.roomAttempted) || (value.linked && !value.roomId) ||
		(value.roomId !== undefined && value.roomId === value.hostSpace)) throw Error("Invalid coordinator provisioning intent");
	return value;
}

/** Used only before the first coordinator manifest. Existing identities never flow through creation. */
export async function provisionCoordinatorRooms(path: string, hostId: string, concept: string, matrix: ManagedMatrixClient, signal?: AbortSignal): Promise<{ roomId: string; hostSpace: string }> {
	signal?.throwIfAborted();
	const file = new AtomicJsonFile(path, parse);
	let intent = await file.read();
	if (intent && intent.hostId !== hostId) throw Error("Coordinator provisioning belongs to another host");
	if (!intent) {
		intent = { version: 1, hostId, conversationId: deriveConversationId(hostId, "coordinator"), hostAttempted: false, roomAttempted: false, linked: false };
		await file.write(intent);
	}
	const hostProof: ManagedProvenance = { version: 1, hostId, kind: "host_space", creationKey: "host" };
	if (!intent.hostSpace) {
		let hostSpace: string | undefined;
		if (intent.hostAttempted) hostSpace = await matrix.recoverManagedAlias(hostProof, signal);
		else {
			signal?.throwIfAborted();
			intent = { ...intent, hostAttempted: true }; await file.write(intent);
			hostSpace = await matrix.ensureManagedRoom(`pi · ${hostId}`, hostProof, signal);
		}
		if (!hostSpace) throw new ManagedMatrixError("invalid_response", "Uncertain host Space creation requires explicit reconciliation");
		intent = { ...intent, hostSpace }; await file.write(intent);
	} else await matrix.recoverManagedRoom(intent.hostSpace, hostProof, signal);
	const hostSpace = intent.hostSpace;
	if (!hostSpace) throw Error("Coordinator host Space is pending");
	const proof: ManagedProvenance = { version: 1, hostId, kind: "coordinator", creationKey: "coordinator", conversationId: intent.conversationId, parentRoomId: hostSpace };
	if (!intent.roomId) {
		let roomId: string | undefined;
		if (intent.roomAttempted) roomId = await matrix.recoverManagedAlias(proof, signal);
		else {
			signal?.throwIfAborted();
			intent = { ...intent, roomAttempted: true }; await file.write(intent);
			roomId = await matrix.ensureManagedRoom(`pi · ${concept}`, proof, signal);
		}
		if (!roomId) throw new ManagedMatrixError("invalid_response", "Uncertain coordinator room creation requires explicit reconciliation");
		intent = { ...intent, roomId }; await file.write(intent);
	} else await matrix.recoverManagedRoom(intent.roomId, proof, signal);
	const roomId = intent.roomId;
	if (!roomId) throw Error("Coordinator room is pending");
	if (!intent.linked) { await matrix.addSpaceChild(hostSpace, roomId, signal); intent = { ...intent, linked: true }; await file.write(intent); }
	return { roomId, hostSpace };
}
