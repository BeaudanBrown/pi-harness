import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import diagramTools from "../config/agent/extensions/diagram-tools/index.js";

function fixture(t: TestContext) {
	const cwd = mkdtempSync(join(tmpdir(), "diagram-test-")), tools = new Map<string, any>();
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	diagramTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
	const put = (file: string, text: string) => { mkdirSync(join(cwd, file, ".."), { recursive: true }); writeFileSync(join(cwd, file), text); };
	return { cwd, tools, put, call: (name: string, params: unknown = {}, signal?: AbortSignal) => tools.get(name).execute("test", params, signal, undefined, { cwd }) };
}

test("one discovery surface, generated inventory opt-in, and cwd-relative queries", async t => {
	const f = fixture(t);
	assert.ok(f.tools.has("architecture_discover")); assert.ok(!f.tools.has("architecture_commands") && !f.tools.has("architecture_queries"));
	f.put("diagrams/main.d2", "a -> b"); f.put(".pi/tmp/reviews/copy/main.d2", "a -> b");
	assert.equal(JSON.parse((await f.call("diagram_inventory")).content[0].text).length, 1);
	assert.equal(JSON.parse((await f.call("diagram_inventory", { includeGenerated: true })).content[0].text).length, 2);
	f.put(".pi/architecture.json", JSON.stringify({ queries: { large: {
		command: [process.execPath, "-e", `let input='';process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>console.log(JSON.stringify({payload:JSON.parse(input),cwd:process.cwd(),env:process.env.PI_ARCHITECTURE_QUERY_NAME,summary:'x'.repeat(30000)})))`],
		parameters: { depth: { type: "number", default: 2 } },
	} } }));
	const response = await f.call("architecture_query", { name: "large" });
	assert.match(response.content[0].text, /Truncated/);
	const full = JSON.parse(readFileSync(join(f.cwd, response.details.fullPath), "utf8"));
	assert.equal(full.summary.length, 30_000); assert.equal(full.cwd, f.cwd); assert.equal(full.env, "large");
	assert.deepEqual(full.payload, { name: "large", args: { depth: 2 } });
	await assert.rejects(f.call("architecture_query", { name: "large", args: { depth: "bad" } }), /Invalid query parameter/);
});

test("all renderer adapters create the reported artifact; validation cleans temporary output", async t => {
	const f = fixture(t), fake = join(f.cwd, "renderer");
	writeFileSync(fake, `#!${process.execPath}
const fs=require('node:fs'),p=require('node:path'),a=process.argv.slice(2);
if(a[0]==='validate'||a[0]==='-checkonly')process.exit(0);
let out=a.includes('-output')?a[a.indexOf('-output')+1]:a.includes('-o')?a[a.indexOf('-o')+1]:a[1];
if(a[0]==='export'){fs.mkdirSync(out,{recursive:true});out=p.join(out,'view.puml')}
else if(a.includes('-o')&&a.at(-1).endsWith('.puml'))out=p.join(out,p.parse(a.at(-1)).name+'.svg');
fs.writeFileSync(out,'rendered');
`, { mode: 0o700 });
	for (const [language, variable] of Object.entries({ d2: "PI_HARNESS_D2", dot: "PI_HARNESS_DOT", mermaid: "PI_HARNESS_MERMAID_CLI", plantuml: "PI_HARNESS_PLANTUML", structurizr: "PI_HARNESS_STRUCTURIZR" })) {
		const prior = process.env[variable]; process.env[variable] = fake;
		t.after(() => { if (prior === undefined) delete process.env[variable]; else process.env[variable] = prior; });
		const outputPath = language === "structurizr" ? "output" : `output/${language}.svg`;
		const response = await f.call("diagram_render", { language, source: "fixture", outputPath });
		assert.equal(JSON.parse(response.content[0].text).outputPath, outputPath);
		assert.equal(readFileSync(join(f.cwd, outputPath, ...(language === "structurizr" ? ["view.puml"] : [])), "utf8"), "rendered");
		await f.call("diagram_render", { language, source: "fixture", mode: "validate" });
	}
	for (const dir of readdirSync(join(f.cwd, ".pi/tmp/architecture-tools"))) {
		assert.ok(!readdirSync(join(f.cwd, ".pi/tmp/architecture-tools", dir)).some(file => /^input\.(?:puml|mmd|dot|dsl|d2)$/.test(file)));
	}
	await assert.rejects(f.call("diagram_render", { language: "structurizr", source: "fixture", format: "png" }), /supports/);
});

test("render failures clean inline input and never claim an output; paths reject escapes", async t => {
	const f = fixture(t), prior = process.env.PI_HARNESS_D2;
	process.env.PI_HARNESS_D2 = join(f.cwd, "missing");
	t.after(() => { if (prior === undefined) delete process.env.PI_HARNESS_D2; else process.env.PI_HARNESS_D2 = prior; });
	await assert.rejects(f.call("diagram_render", { language: "d2", source: "fixture" }), /ENOENT/);
	const dir = join(f.cwd, ".pi/tmp/architecture-tools", readdirSync(join(f.cwd, ".pi/tmp/architecture-tools"))[0]);
	assert.ok(!readdirSync(dir).includes("input.d2"));
	await assert.rejects(f.call("diagram_render", { language: "d2", source: "fixture", outputPath: "../outside.svg" }), /outside repository/);
	symlinkSync(tmpdir(), join(f.cwd, "output"));
	await assert.rejects(f.call("diagram_render", { language: "d2", source: "fixture", outputPath: "output/out.svg" }), /Symlink outside/);
});

test("architecture commands propagate failure, timeout and cancellation through the shared runner", async t => {
	const f = fixture(t);
	f.put(".pi/architecture.json", JSON.stringify({ commands: {
		fail: { command: [process.execPath, "-e", "console.error('fixture failure');process.exit(7)"] },
		hang: { command: [process.execPath, "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},100)"] },
	} }));
	await assert.rejects(f.call("architecture_command", { name: "fail" }), /Exit 7[\s\S]*fixture failure/);
	await assert.rejects(f.call("architecture_command", { name: "hang", timeoutMs: 200 }), /Timed out/);
	await assert.rejects(f.call("architecture_command", { name: "hang" }, AbortSignal.abort()), /Cancelled/);
});
