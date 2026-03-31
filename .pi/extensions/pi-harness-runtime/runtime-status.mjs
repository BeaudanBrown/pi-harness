import { readFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const runtimeEnv = Object.freeze({
  workstreamID: "PI_HARNESS_WORKSTREAM_ID",
  runtimeDir: "PI_HARNESS_RUNTIME_DIR",
  tmuxSession: "PI_HARNESS_TMUX_SESSION",
});

const schemaVersion = 1;

function readConfig(env) {
  const workstreamID = env[runtimeEnv.workstreamID]?.trim() ?? "";
  const runtimeDir = env[runtimeEnv.runtimeDir]?.trim() ?? "";
  const tmuxSession = env[runtimeEnv.tmuxSession]?.trim() ?? "";
  if (!workstreamID || !runtimeDir || !tmuxSession) {
    return null;
  }
  return {
    workstreamID,
    runtimeDir,
    tmuxSession,
  };
}

async function readCurrentStatus(fsImpl, filePath) {
  try {
    const raw = await fsImpl.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.lastProcessingAt === "string" ? parsed : null;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

async function writeAtomically(fsImpl, filePath, payload) {
  await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsImpl.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fsImpl.rename(tempPath, filePath);
  } finally {
    await fsImpl.rm(tempPath, { force: true });
  }
}

export function createRuntimeStatusAdapter(options = {}) {
  const env = options.env ?? process.env;
  const fsImpl = options.fs ?? { readFile, mkdir, rename, rm, writeFile };
  const getCwd = options.cwd ?? (() => process.cwd());
  const now = options.now ?? (() => new Date().toISOString());
  const config = readConfig(env);

  async function writeStatus(state) {
    if (!config) {
      return false;
    }

    const filePath = path.join(config.runtimeDir, `${config.workstreamID}.json`);
    const timestamp = now();
    const current = await readCurrentStatus(fsImpl, filePath);
    const lastProcessingAt =
      state === "processing" ? timestamp : current?.lastProcessingAt ?? "";

    const payload = {
      schemaVersion,
      workstreamId: config.workstreamID,
      tmuxSession: config.tmuxSession,
      state,
      cwd: getCwd(),
      lastSeenAt: timestamp,
      ...(lastProcessingAt ? { lastProcessingAt } : {}),
    };

    await writeAtomically(fsImpl, filePath, payload);
    return true;
  }

  return {
    config,
    async handleSessionStart() {
      return writeStatus("idle");
    },
    async handleAgentStart() {
      return writeStatus("processing");
    },
    async handleAgentEnd() {
      return writeStatus("idle");
    },
    async handleSessionShutdown() {
      return writeStatus("idle");
    },
    register(pi) {
      if (!config) {
        return;
      }
      pi.on("session_start", () => writeStatus("idle"));
      pi.on("agent_start", () => writeStatus("processing"));
      pi.on("agent_end", () => writeStatus("idle"));
      pi.on("session_shutdown", () => writeStatus("idle"));
    },
  };
}

export default function registerRuntimeStatusExtension(pi) {
  createRuntimeStatusAdapter().register(pi);
}
