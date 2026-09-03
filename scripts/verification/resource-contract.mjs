#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const settings = JSON.parse(await readFile(path.join(root, "config/agent/settings.json"), "utf8"));
const profiles = JSON.parse(await readFile(path.join(root, "config/agent/profiles.json"), "utf8"));
const externalExtensions = new Set(["agentgraph", "lsp", "managed-coordinator", "pi-r"]);

assert.equal(settings.enableSkillCommands, true, "skill commands must remain enabled");
assert.ok(Array.isArray(settings.extensions), "settings.extensions must be an array");
assert.ok(profiles.profiles?.["engineering-full"], "engineering-full profile is required");

const configured = new Set();
for (const relative of settings.extensions) {
  assert.match(relative, /^\.\/extensions\/[A-Za-z0-9._+-]+\/index\.ts$/, `unsupported extension path: ${relative}`);
  assert.ok(!configured.has(relative), `duplicate settings extension: ${relative}`);
  configured.add(relative);
  await access(path.join(root, "config/agent", relative));
}

const engineeringHarnessExtensions = profiles.profiles["engineering-full"].extensions
  .filter((name) => !externalExtensions.has(name))
  .map((name) => `./extensions/${name}/index.ts`);
assert.deepEqual([...configured].sort(), engineeringHarnessExtensions.sort(),
  "settings extensions must be derived from the engineering-full profile");

for (const [profileName, profile] of Object.entries(profiles.profiles)) {
  for (const extension of profile.extensions ?? []) {
    if (externalExtensions.has(extension)) continue;
    const extensionPath = path.join(root, "config/agent/extensions", extension, "index.ts");
    await access(extensionPath).catch(() => {
      throw new Error(`profile ${profileName} references missing extension ${extension}`);
    });
  }
}

for (const directory of settings.skills ?? []) await access(path.join(root, "config/agent", directory));
for (const directory of settings.prompts ?? []) await access(path.join(root, "config/agent", directory));
for (const directory of settings.themes ?? []) await access(path.join(root, "config/agent", directory));

console.log(`resource contract: ${configured.size} default extensions and ${Object.keys(profiles.profiles).length} profiles`);
