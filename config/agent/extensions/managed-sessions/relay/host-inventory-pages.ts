import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { HOST_INVENTORY_PAGE_SIZE, parseHostAction, type HostAction } from "../live-workspace-contracts.js";
import { HostControlError } from "./host-control-error.js";

type PageAction = Extract<HostAction, { operation: "conversation.list" | "conversation.archive.list" | "workspace.list" | "worktree.list" }>;
interface Snapshot { scope: string; revision: string; expiresAt: number; rows: unknown[]; bytes: number }
const LIFETIME_MS = 60_000;
const MAX_SNAPSHOTS = 8;
const MAX_ROWS = 4_096;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
// Reserve room for the versioned response envelope and opaque cursor.
const PAGE_BYTES = 60 * 1024;

/** Disposable, bounded read snapshots; never an execution/idempotency journal. */
export class HostInventoryPages {
	private readonly secret = randomBytes(32);
	private readonly snapshots = new Map<string, Snapshot>();
	constructor(private readonly hostId: string, private readonly now: () => number = () => performance.now()) {}

	page<T>(action: PageAction, rows: readonly T[]): { items: T[]; nextCursor: string | null } {
		parseHostAction(action);
		if (!["conversation.list", "conversation.archive.list", "workspace.list", "worktree.list"].includes(action.operation)) throw new HostControlError("invalid_request", "Action has no inventory pages");
		if (rows.length > MAX_ROWS) throw new HostControlError("unavailable", "Inventory exceeds the bounded snapshot capacity");
		const encoded = JSON.stringify(rows); const bytes = Buffer.byteLength(encoded);
		if (bytes > MAX_SNAPSHOT_BYTES) throw new HostControlError("unavailable", "Inventory exceeds the bounded snapshot capacity");
		const revision = createHash("sha256").update(encoded).digest("hex");
		const scope = JSON.stringify([this.hostId, action.operation, "rootKey" in action ? action.rootKey : null, "workspace" in action ? action.workspace : null]);
		const now = this.now();
		for (const [id, snapshot] of this.snapshots) if (snapshot.expiresAt <= now) this.snapshots.delete(id);
		let id: string; let snapshot: Snapshot; let offset = 0;
		if (action.cursor) {
			const match = /^([A-Za-z0-9_-]{32})\.([1-9][0-9]{0,3})\.([A-Za-z0-9_-]{43})$/.exec(action.cursor);
			if (!match || !timingSafeEqual(Buffer.from(this.signature(`${match[1]}.${match[2]}`).toString("base64url")), Buffer.from(match[3]))) this.stale();
			id = match[1]; offset = Number(match[2]);
			const saved = this.snapshots.get(id);
			if (!saved || saved.scope !== scope || saved.revision !== revision || offset >= saved.rows.length) this.stale();
			snapshot = saved;
		} else {
			const existing = [...this.snapshots].find(([, value]) => value.scope === scope && value.revision === revision);
			if (existing) [id, snapshot] = existing;
			else {
				let total = [...this.snapshots.values()].reduce((sum, value) => sum + value.bytes, 0);
				while (this.snapshots.size >= MAX_SNAPSHOTS || total + bytes > MAX_TOTAL_BYTES) {
					const oldest = this.snapshots.entries().next().value!;
					total -= oldest[1].bytes; this.snapshots.delete(oldest[0]);
				}
				id = randomBytes(24).toString("base64url");
				snapshot = { scope, revision, expiresAt: now + LIFETIME_MS, rows: structuredClone([...rows]), bytes };
				this.snapshots.set(id, snapshot);
			}
		}
		const items: T[] = []; let pageBytes = 2;
		while (offset < snapshot.rows.length && items.length < (action.limit ?? HOST_INVENTORY_PAGE_SIZE)) {
			const row = snapshot.rows[offset]; const rowBytes = Buffer.byteLength(JSON.stringify(row)) + 1;
			if (rowBytes + pageBytes > PAGE_BYTES) {
				if (!items.length) throw new HostControlError("failed", "Inventory row exceeds the response budget");
				break;
			}
			items.push(structuredClone(row) as T); pageBytes += rowBytes; offset++;
		}
		const position = `${id}.${offset}`;
		return { items, nextCursor: offset < snapshot.rows.length ? `${position}.${this.signature(position).toString("base64url")}` : null };
	}

	private signature(position: string): Buffer { return createHmac("sha256", this.secret).update(position).digest(); }
	private stale(): never { throw new HostControlError("stale_preview", "Inventory cursor is stale; request the first page again", true); }
}
