import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { BridgeRelay } from "../config/agent/extensions/matrix-bridge/relay.js";
import { BridgeMatrix } from "../config/agent/extensions/matrix-bridge/matrix.js";
import { MatrixHttp } from "../config/agent/extensions/matrix-shared/http.js";

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 8000;
  while (!await check()) { if (Date.now() > end) throw Error("TUI bridge condition timed out"); await new Promise(resolve => setTimeout(resolve, 50)); }
}
test("ordinary interactive Pi enrolls automatically, remains usable offline, and stops through its native TUI", { timeout: 25000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-tui-")), file = join(root, "native.jsonl"), socket = join(root, "bridge.sock"), tmuxSocket = join(root, "tmux.sock"), home = join(root, "home");
  mkdirSync(home);
  const pi = process.env.PI_BRIDGE_TEST_PI, sdk = process.env.PI_BRIDGE_TEST_SDK, tmux = process.env.PI_TEST_TMUX ?? "tmux";
  assert.ok(pi); assert.ok(sdk);
  const env = { HOME: home, PATH: process.env.PATH, TERM: "xterm-256color", PI_CODING_AGENT_DIR: join(home, ".pi"), PI_SESSION_LOCK_DIRECTORY: join(root, "locks") };
  const runTmux = (...args: string[]) => spawnSync(tmux, ["-S", tmuxSocket, "-f", "/dev/null", ...args], { env, encoding: "utf8" });
  const config = { hostId: "host", stateDirectory: join(root, "state"), socket, roots: [root] };
  const extension = join(root, "extension.ts");
  writeFileSync(extension, `import {installAdapter} from ${JSON.stringify(resolve("config/agent/extensions/matrix-bridge/adapter.ts"))}; export default pi => installAdapter(pi,{config:${JSON.stringify({ socket, roots: [root] })}});`);
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "native", cwd: root, timestamp: new Date().toISOString() }) + "\n");
  const matrix = new BridgeMatrix(new MatrixHttp({ homeserver: "https://example.org", accessToken: "daemon-only" }, async (url) => {
    if (String(url).includes("/state/m.room.member/")) return Response.json({ membership: "join" });
    if (String(url).includes("/send/")) return Response.json({ event_id: "$sent" });
    throw Error("Matrix deliberately offline");
  }, { maxAttempts: 1 }), "@bridge:example.org");
  const relay = new BridgeRelay(config, matrix, async () => { throw Error("no replacement of ordinary local Pi"); });
  try {
    // Start without a daemon. The TUI must still start and keep its real writer.
    const opened = runTmux("new-session", "-d", "-s", "bridge-test", "-c", root, "--", pi, "--session", file, "--no-extensions", "--no-skills", "--no-context-files", "--no-builtin-tools", "--extension", extension,
      "--extension", resolve("tests/fixtures/matrix-bridge/native-probe.mjs"), "--provider", "bridge-probe", "--model", "fake");
    assert.equal(opened.status, 0, opened.stderr);
    await until(() => readFileSync(file, "utf8").includes("matrix-bridge.boundary"));
    const writerAvailable = () => spawnSync(process.execPath, ["-e", `const lock=require(${JSON.stringify(join(sdk, "core/session-lock.cjs"))}); const release=lock.acquireSessionLock(${JSON.stringify(file)}); release();`], { env, encoding: "utf8" }).status === 0;
    assert.equal(writerAvailable(), false);
    // These keystrokes simulate a human in this disposable local terminal;
    // the bridge itself never uses tmux keystrokes to submit remote input.
    assert.equal(runTmux("send-keys", "-t", "bridge-test:0.0", "-l", "offline local prompt").status, 0);
    assert.equal(runTmux("send-keys", "-t", "bridge-test:0.0", "Enter").status, 0);
    await until(() => readFileSync(file, "utf8").includes("probe answer"));
    await relay.start(false);
    await until(() => relay.store.bindings().length === 1);
    const binding = relay.store.bindings()[0]!; relay.store.setRoom(binding.key, "!room:example.org");
    relay.store.intake("stop", [{ id: "$stop", room: "!room:example.org", event: { event_id: "$stop", type: "m.room.message", sender: "@friend:example.org", content: { msgtype: "m.text", body: "!stop" } } }]);
    await relay.pump();
    await until(writerAvailable);
    assert.ok(readFileSync(file, "utf8").includes("matrix-bridge.boundary"));
  } finally { await relay.stop(); runTmux("kill-server"); rmSync(root, { recursive: true, force: true }); }
});
