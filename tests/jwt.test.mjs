import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  Client,
  jwtAuthenticator,
  credentialsAuthenticator,
} from "../platform/client.mjs";
import { startServer } from "../examples/server.mjs";
test("real operator-mode server validates JWT nonce signatures rotation and expired-user denial", async () => {
  const helper = fileURLToPath(
    new URL(
      "../.local/tools/" +
        (process.platform === "win32" ? "interop-go.exe" : "interop-go"),
      import.meta.url,
    ),
  );
  const r = spawnSync(helper, ["auth"], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 65536,
  });
  assert.equal(
    r.status,
    0,
    "Build official reference fixture before testing JWT",
  );
  const keys = JSON.parse(r.stdout);
  const server = await startServer({
    operator: keys.operator,
    accounts: {
      [keys.account]: keys.accountJWT,
      [keys.system]: keys.systemJWT,
    },
  });
  let c;
  try {
    await assert.rejects(
      Client.connect(server.url, {
        authenticator: jwtAuthenticator(keys.expiredJWT, keys.expiredSeed),
        maxReconnects: 0,
      }),
    );
    await assert.rejects(
      Client.connect(server.url, {
        authenticator: jwtAuthenticator(keys.firstJWT, keys.secondSeed),
        maxReconnects: 0,
      }),
    );
    let which = "first",
      calls = 0;
    const creds = credentialsAuthenticator(() => {
      calls++;
      return (
        "-----BEGIN NATS USER JWT-----\n" +
        keys[which + "JWT"] +
        "\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\n" +
        keys[which + "Seed"] +
        "\n------END USER NKEY SEED------"
      );
    });
    c = await Client.connect(server.url, { authenticator: creds });
    await c.createStream("JWT", "jwt.>");
    which = "second";
    await server.restart();
    await c.waitConnected();
    assert.ok(calls >= 2);
    assert.equal((await c.streamInfo("JWT")).config.name, "JWT");
    const publicStats = JSON.stringify(c.stats());
    assert.ok(!publicStats.includes(keys.firstSeed));
    assert.ok(!publicStats.includes(keys.firstJWT));
  } finally {
    c?.close();
    await server.cleanup();
  }
});
