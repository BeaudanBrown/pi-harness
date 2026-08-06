import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const command = process.env.PI_MATRIX_WHOAMI;

async function runWhoami(
  homeserver: string,
  expectedUserId: string,
  accessToken = "secret-test-token",
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  assert.ok(command, "PI_MATRIX_WHOAMI must identify the packaged smoke-check command");

  return await new Promise((resolve, reject) => {
    const child = spawn(command, [], {
      env: {
        ...process.env,
        PI_MATRIX_HOMESERVER: homeserver,
        PI_MATRIX_ACCESS_TOKEN: accessToken,
        PI_MATRIX_BOT_USER_ID: expectedUserId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function withWhoamiServer(
  userId: string,
  run: (homeserver: string, authorization: () => string | undefined) => Promise<void>,
): Promise<void> {
  let observedAuthorization: string | undefined;
  const server = createServer((request, response) => {
    observedAuthorization = request.headers.authorization;
    assert.equal(request.url, "/_matrix/client/v3/account/whoami");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ user_id: userId }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    await run(`http://127.0.0.1:${address.port}`, () => observedAuthorization);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("verifies the configured Matrix user without printing the token", async () => {
  const token = "secret-test-token";
  await withWhoamiServer("@pi-grill:matrix.bepis.lol", async (homeserver, authorization) => {
    const result = await runWhoami(homeserver, "@pi-grill:matrix.bepis.lol", token);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "@pi-grill:matrix.bepis.lol\n");
    assert.equal(authorization(), `Bearer ${token}`);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
  });
});

test("rejects an unexpected authenticated Matrix user without printing the token", async () => {
  const token = "another-secret-token";
  await withWhoamiServer("@someone-else:matrix.bepis.lol", async (homeserver) => {
    const result = await runWhoami(homeserver, "@pi-grill:matrix.bepis.lol", token);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /expected @pi-grill:matrix\.bepis\.lol/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
  });
});
