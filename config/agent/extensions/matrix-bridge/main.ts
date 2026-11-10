import { readFileSync } from "node:fs";
import { MatrixHttp } from "../matrix-shared/http.js";
import { BridgeMatrix } from "./matrix.js";
import { BridgeRelay, type RelayConfig } from "./relay.js";
import { localOpen, localTasks } from "./local-process.js";
export { localEnvironment, localOpen } from "./local-process.js";
import { hostPath, object, string } from "./wire.js";
export function credential(source: string): string {
  // Consume the existing SOPS environment-file format without evaluating shell
  // text or exporting its value to Pi/tmux/Git children.
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  if (lines.length !== 1) throw Error("Matrix credential file must contain exactly PI_MATRIX_ACCESS_TOKEN");
  const match = /^PI_MATRIX_ACCESS_TOKEN=(?:"([^"\s]+)"|'([^'\s]+)'|([^\s'"]+))$/.exec(lines[0]!);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!value || value.length > 4096) throw Error("Invalid Matrix credential file");
  return value;
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length !== 4 || args[0] !== "--config" || args[2] !== "--credential-file") throw Error("Usage: pi-matrix-bridge --config FILE --credential-file FILE");
  const raw = object(JSON.parse(readFileSync(args[1]!, "utf8")));
  if (!Array.isArray(raw.roots) || !raw.roots.length || !Array.isArray(raw.ignoredSenderUserIds)) throw Error("Invalid bridge roots or ignored users");
  if (raw.hostSpace !== undefined && typeof raw.hostSpace !== "boolean") throw Error("Invalid host Space preference");
  const config: RelayConfig = { hostId: string(raw.hostId, 128), stateDirectory: hostPath(string(raw.stateDirectory)), socket: hostPath(string(raw.socket)), roots: raw.roots.map(root => hostPath(string(root))), operatorUserId: string(raw.operatorUserId, 255), hostSpace: raw.hostSpace !== false };
  const client = new BridgeMatrix(new MatrixHttp({ homeserver: string(raw.homeserver), accessToken: credential(readFileSync(args[3]!, "utf8")) }, fetch, { maxAttempts: 1 }),
    string(raw.botUserId, 255), new Set(raw.ignoredSenderUserIds.map(sender => string(sender, 255))));
  const account = object(await client.http.request("GET", "/_matrix/client/v3/account/whoami", undefined, AbortSignal.timeout(8000)));
  if (account.user_id !== client.userId || account.is_guest === true) throw Error("Matrix credential does not match the configured host bot");
  const relay = new BridgeRelay(config, client, localOpen(string(raw.localHelper)), raw.taskHelper === undefined ? undefined : localTasks(string(raw.taskHelper)));
  const shutdown = () => { void relay.stop().catch(() => { process.exitCode = 1; }); };
  process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
  try { await relay.start(); }
  catch (error) { await relay.stop(); throw error; }
}
if (require.main === module) void main().catch(error => {
  // Config/transport errors never print credential contents or remote payloads.
  console.error(error instanceof Error ? error.message : "Matrix bridge startup failed"); process.exitCode = 1;
});
