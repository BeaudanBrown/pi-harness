import { runEvalCli, type EvalCliRuntimeConfig } from "./cli.js";

const runtime: EvalCliRuntimeConfig = {
	identityManifestPath: process.env.PI_EVAL_LAUNCHER_IDENTITY ?? "",
	expected: {
		piVersion: process.env.PI_EVAL_EXPECTED_PI_VERSION ?? "",
		harnessRevision: process.env.PI_EVAL_EXPECTED_HARNESS_REVISION ?? "",
		launcherId: process.env.PI_EVAL_EXPECTED_LAUNCHER_ID ?? "",
		launcherPath: process.env.PI_EVAL_EXPECTED_LAUNCHER_PATH ?? "",
		piRRevision: process.env.PI_EVAL_EXPECTED_PI_R_REVISION ?? "",
		resourceRoot: process.env.PI_EVAL_EXPECTED_PI_R_ROOT ?? "",
		extensionPath: process.env.PI_EVAL_EXPECTED_PI_R_EXTENSION ?? "",
		skillPath: process.env.PI_EVAL_EXPECTED_PI_R_SKILL ?? "",
	},
};

runEvalCli(process.argv.slice(2), runtime, {
	stdout: (value) => process.stdout.write(value),
	stderr: (value) => process.stderr.write(value),
}).then((code) => {
	process.exitCode = code;
}, () => {
	process.stderr.write("pi-eval: unexpected fatal error\n");
	process.exitCode = 1;
});
