import { isSoleRoomCreator } from "./room-creator.js";

export const BRIDGE_ROOM_STAMP = "lol.bepis.pi.bridge";
export type BridgeRoomKind = "host" | "project" | "checkout" | "conversation" | "archive";
export type BridgeRoomStamp = { version: 1; host: string; node: string; kind: BridgeRoomKind };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function roomStamp(value: unknown): BridgeRoomStamp {
  const stamp = object(value);
  if (stamp.version !== 1 || typeof stamp.host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(stamp.host) ||
      typeof stamp.node !== "string" || !/^[a-f0-9]{64}$/.test(stamp.node) || !["host", "project", "checkout", "conversation", "archive"].includes(String(stamp.kind))) throw Error("Invalid native bridge room identity");
  return { version: 1, host: stamp.host, node: stamp.node, kind: stamp.kind as BridgeRoomKind };
}
/** Shared by host setup and the account's invitation reader. Names/aliases and
 * mutable power levels never grant ownership. Unknown creator semantics fail closed. */
export function ownedBridgeRoom(events: unknown, bot: string, expected?: BridgeRoomStamp): BridgeRoomStamp {
  if (!Array.isArray(events) || events.length > 4096) throw Error("Invalid bridge room state");
  const creates = events.map(object).filter(event => event.type === "m.room.create" && event.state_key === "");
  if (creates.length !== 1 || !isSoleRoomCreator(creates[0], bot)) throw Error("Bridge room has a foreign or ambiguous creator");
  const content = object(creates[0]!.content), stamp = roomStamp(content[BRIDGE_ROOM_STAMP]);
  if ((stamp.kind === "conversation" ? content.type !== undefined : content.type !== "m.space") || content["m.federate"] !== false ||
      events.some(event => object(event).type === "m.room.encryption")) throw Error("Unsupported bridge room policy");
  if (expected && (stamp.host !== expected.host || stamp.node !== expected.node || stamp.kind !== expected.kind)) throw Error("Bridge room identity conflict");
  return stamp;
}
