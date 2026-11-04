import { isDeepStrictEqual } from "node:util";
import type { HostAccountClient } from "./host-account-client.js";

export type MembershipIdentity = { conversationId: string; roomId: string; hostSpaceId: string; operatorUserId: string; botUserId: string; sourceDigest: string };
type Member = { eventId: string; sender: string; membership: string };
export type MembershipRepairPlan = { identity: MembershipIdentity; member: Member; departureEventId?: string };
/** Internal approved orchestration port. No automatic invitation/replay loop. */
export class MembershipRepairOwner {
 constructor(private readonly options: {
  client: HostAccountClient;
  identity(id: string): Promise<MembershipIdentity>;
  member(room: string): Promise<Member>;
  invite(room: string): Promise<void>;
  now?: () => number;
 }) {}
 private now(): number { return (this.options.now ?? Date.now)(); }
 private async observe(id: string): Promise<{ identity: MembershipIdentity; member: Member }> {
  const identity = await this.options.identity(id);
  const member = await this.options.member(identity.roomId);
  if (!isDeepStrictEqual(identity, await this.options.identity(id))) throw Error("Membership identity changed; obtain fresh consent");
  if (!["leave", "invite", "join"].includes(member.membership)) throw Error("Membership is banned or unknown; external action is required");
  if (["leave", "join"].includes(member.membership) && member.sender !== identity.operatorUserId || member.membership === "invite" && member.sender !== identity.botUserId) throw Error("Membership authority is foreign; external action is required");
  return { identity, member };
 }
 async snapshot(conversationId: string): Promise<MembershipRepairPlan> {
  const observed = await this.observe(conversationId);
  const request = await this.options.client.request({ operation: "room.membership.inspect", roomId: observed.identity.roomId, conversationId, membershipEventId: observed.member.eventId });
  const ack = this.options.client.freshAck(request.requestId);
  if (ack?.membershipRepair?.retired) throw Error("Original room is terminal on NAS and is not restorable");
  if (ack?.status !== "complete" || ack.membershipRepair?.capability !== "original-room-repair-v1") throw Error("NAS membership repair support is unconfirmed; await account connectivity or upgrade NAS before effects");
  if (!isDeepStrictEqual(observed, await this.observe(conversationId))) throw Error("Membership scope changed; obtain fresh consent");
  return { ...observed, ...(ack.membershipRepair.departureEventId ? { departureEventId: ack.membershipRepair.departureEventId } : {}) };
 }
 async reconcile(plan: MembershipRepairPlan, operationId: string, expiresAt: number): Promise<{ conversationId: string; setupState: "pending" | "ready" }> {
  const { identity, member } = plan;
  const old = this.options.client.membershipRequest(operationId);
  const body = { operation: "room.membership.restore" as const, roomId: identity.roomId, conversationId: identity.conversationId, hostSpaceId: identity.hostSpaceId,
   operationId, sourceDigest: identity.sourceDigest, expiresAt, membership: member.membership as "leave" | "invite" | "join", membershipEventId: member.eventId,
   ...(plan.departureEventId ? { departureEventId: plan.departureEventId } : {}) };
  if (old && Object.entries(body).some(([key, value]) => (old as unknown as Record<string, unknown>)[key] !== value) || old && old.departureEventId !== plan.departureEventId) throw Error("Membership operation scope changed");
  let current = await this.observe(identity.conversationId);
  if (!isDeepStrictEqual(current.identity, identity)) throw Error("Membership identity changed; obtain fresh consent");
  const validTransition = (observed: Member): boolean => {
   if (isDeepStrictEqual(observed, member)) return true;
   if (!old) return false;
   const authorized = this.options.client.membershipAuthorization(old.requestId);
   if (observed.membership === "join") return authorized?.membership === "invite";
   return member.membership === "leave" && observed.membership === "invite" && this.options.client.membershipInvitationAttempted(old.requestId) &&
    (!authorized || authorized.membershipEventId === observed.eventId);
  };
  if (!validTransition(current.member)) throw Error("Membership evidence changed; obtain fresh consent");
  const result = (setupState: "pending" | "ready") => ({ conversationId: identity.conversationId, setupState });
  if (old && this.options.client.ack(old.requestId)?.status === "complete") {
   if (current.member.membership !== "join") throw Error("Membership changed after completion; obtain fresh consent");
   await this.snapshot(identity.conversationId);
   return result("ready");
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now() || expiresAt > this.now() + 600_000) throw Error("Membership consent expired; obtain fresh consent");
  if (!old && !isDeepStrictEqual(plan, await this.snapshot(identity.conversationId))) throw Error("Membership scope changed; obtain fresh consent");
  const request = await this.options.client.request(body);
  const ack = this.options.client.ack(request.requestId);
  if (ack?.status === "rejected" || ack?.code === "conflict" || ack?.code === "unverified") throw Error("NAS refused membership repair; inspect terminal authority or changed departure");
  if (ack?.code === "join_observed") {
   const authorized = this.options.client.membershipAuthorization(request.requestId);
   current = await this.observe(identity.conversationId);
   if (!isDeepStrictEqual(current.identity, identity) || current.member.membership !== "join" || authorized?.membership !== "invite" || !validTransition(current.member)) throw Error("Joined membership evidence changed; obtain fresh consent");
   await this.options.client.request({ operation: "room.membership.confirm", roomId: identity.roomId, conversationId: identity.conversationId,
    restoreRequestId: request.requestId, membershipEventId: current.member.eventId });
   return result("pending");
  }
  // A durable NAS admission must precede the host invitation. No response is not permission.
  if (ack?.code !== "admitted") return result("pending");
  current = await this.observe(identity.conversationId);
  if (!isDeepStrictEqual(current.identity, identity) || !validTransition(current.member)) throw Error("Membership evidence changed before invitation");
  if (current.member.membership === "leave") {
   if (!isDeepStrictEqual(current.member, member)) throw Error("Departure changed; obtain fresh consent");
   if (!await this.options.client.beginMembershipInvite(request.requestId)) throw Error("Prior invitation outcome is uncertain; inspect membership before obtaining fresh consent");
   if (!isDeepStrictEqual(current, await this.observe(identity.conversationId))) throw Error("Membership changed before invitation");
   this.options.client.membershipRequest(operationId); // Cancellation may have arrived during observation.
   if (this.options.client.ack(request.requestId)?.code !== "admitted" || expiresAt <= this.now()) throw Error("Membership admission changed before invitation");
   await this.options.invite(identity.roomId);
   // A lost reply is handled by a subsequent observation, never a blind duplicate invite.
   current = await this.observe(identity.conversationId);
  }
  // This operation's durable invitation receipt is the only allowed leave->invite transition.
  const ownInvite = member.membership === "leave" && current.member.membership === "invite" && this.options.client.membershipInvitationAttempted(request.requestId);
  if (!isDeepStrictEqual(current.identity, identity) || !validTransition(current.member) && !ownInvite) throw Error("Membership evidence changed after invitation");
  if (current.member.membership === "leave") return result("pending");
  const authorization = this.options.client.membershipAuthorization(request.requestId);
  if (!authorization) {
   if (expiresAt <= this.now()) throw Error("Membership consent expired before join authorization");
   await this.options.client.request({ operation: "room.membership.authorize", roomId: identity.roomId, conversationId: identity.conversationId,
    restoreRequestId: request.requestId, membership: current.member.membership as "invite" | "join", membershipEventId: current.member.eventId });
  }
  return result("pending");
 }
}
