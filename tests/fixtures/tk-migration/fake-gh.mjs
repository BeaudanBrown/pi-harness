#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

async function main() {
const statePath = process.env.FAKE_GH_STATE;
if (!statePath) throw new Error("FAKE_GH_STATE is required");
if (process.env.FAKE_GH_HANG === "1") await new Promise(() => setInterval(() => {}, 1_000));
if (process.env.FAKE_GH_HANG_CHILD === "1") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
  if (process.env.FAKE_GH_CHILD_PID_PATH) await writeFile(process.env.FAKE_GH_CHILD_PID_PATH, String(child.pid));
  await new Promise(() => setInterval(() => {}, 1_000));
}
let state;
try { state = JSON.parse(await readFile(statePath, "utf8")); } catch { state = { next: 101, issues: [], relationships: [], failedRelationship: false }; }
const save = async () => writeFile(statePath, JSON.stringify(state));
const args = process.argv.slice(2);
if (args[0] === "auth") process.exit(0);
if (args[0] === "repo") { console.log(JSON.stringify({ nameWithOwner: "fixture/repo" })); process.exit(0); }
const endpoint = args.find((arg) => arg === "user" || arg === "rate_limit" || arg.startsWith("repos/") || arg === "search/issues");
const methodIndex = args.indexOf("--method");
const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
let input = {};
if (args.includes("--input")) input = JSON.parse(await new Promise((resolve) => { let value = ""; process.stdin.on("data", (chunk) => value += chunk); process.stdin.on("end", () => resolve(value)); }));
const out = (value) => console.log(JSON.stringify(value));
if (endpoint === "user") return out({ login: "fixture" });
if (endpoint === "search/issues") {
  const queryArg = args.find((arg) => arg.startsWith("q=")) || "";
  const marker = decodeURIComponent(queryArg).match(/pi-harness-plan:[^\s\"]+/)?.[0];
  const pageArg = args.find((arg) => arg.startsWith("page=")) || "page=1";
  const page = Number(pageArg.slice("page=".length));
  const matches = state.issues.filter((issue) => marker && issue.body.includes(marker));
  const noise = process.env.FAKE_GH_SEARCH_NOISE === "1" ? Array.from({ length: 100 }, (_, index) => ({ id: 80_000 + index, number: 80_000 + index, body: "search noise" })) : [];
  const results = [...noise, ...matches];
  return out({ total_count: results.length, items: results.slice((page - 1) * 100, page * 100) });
}
if (endpoint?.includes("/labels/")) { console.error("404 label"); process.exit(1); }
if (endpoint?.endsWith("/labels") && method === "POST") return out(input);
const endpointPath = endpoint?.split("?")[0];
const relationship = endpointPath?.match(/repos\/fixture\/repo\/issues\/(\d+)\/(sub_issues|dependencies\/blocked_by)$/);
if (relationship) {
  const owner = Number(relationship[1]);
  const kind = relationship[2] === "sub_issues" ? "subissue" : "blocker";
  if (method === "GET") {
    const page = Number(new URLSearchParams(endpoint?.split("?")[1] || "").get("page") || "1");
    const matches = state.relationships.filter((edge) => edge.owner === owner && edge.kind === kind).map((edge) => state.issues.find((issue) => issue.id === edge.target) ?? ({ id: edge.target }));
    return out(matches.slice((page - 1) * 100, page * 100));
  }
  if (process.env.FAKE_GH_FAIL_RELATIONSHIP_ONCE === "1" && !state.failedRelationship) {
    state.failedRelationship = true; await save(); console.error("injected relationship failure"); process.exit(1);
  }
  state.relationships.push({ kind, owner, target: input.sub_issue_id ?? input.issue_id }); await save(); return out({ ok: true });
}
const issueMatch = endpointPath?.match(/repos\/fixture\/repo\/issues\/(\d+)$/);
if (issueMatch) {
  const issue = state.issues.find((candidate) => candidate.number === Number(issueMatch[1]));
  if (method === "PATCH") { Object.assign(issue, input); await save(); }
  return out(issue);
}
if (endpoint === "repos/fixture/repo/issues" && method === "POST") {
  const issue = { id: state.next + 1000, number: state.next++, html_url: `https://fixture/${state.next - 1}`, state: "open", ...input };
  state.issues.push(issue); await save(); return out(issue);
}
throw new Error(`unsupported fake gh call: ${args.join(" ")}`);
}

await main();
