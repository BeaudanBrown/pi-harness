type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Evaluate authenticated create state, not an untrusted room ID or power entry.
 * Managed rooms are single-creator. Unknown room versions fail closed because
 * their creator/authority semantics have not been reviewed. */
export function isSoleRoomCreator(event: unknown, expected: string): boolean {
	if (!object(event) || event.type !== "m.room.create" || event.state_key !== "" || event.sender !== expected || !object(event.content)) return false;
	const content = event.content;
	if (content.creator !== undefined && content.creator !== expected) return false;
	if (content.room_version !== undefined && (typeof content.room_version !== "string" || !/^(?:[1-9]|1[0-2])$/.test(content.room_version))) return false;
	return content.room_version !== "12" || content.additional_creators === undefined ||
		(Array.isArray(content.additional_creators) && content.additional_creators.length === 0);
}
