import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createUser } from "@nats-io/nkeys";
import {
  Client,
  command,
  loadCore,
  nkeyAuthenticator,
  credentialsAuthenticator,
} from "../platform/client.mjs";
import { ServerPool } from "../platform/server-pool.mjs";
import { startServer } from "../examples/server.mjs";

test("authentication callback cannot silently downgrade to anonymous or mix mechanisms", async () => {
  const server = await startServer();
  try {
    for (const result of [
      {},
      { jwt: "synthetic" },
      { nkey: "synthetic" },
      { auth_token: "a", user: "b" },
      { pass: "x" },
      { user: "u", sig: "s" },
    ]) {
      await assert.rejects(
        Client.connect(server.url, {
          authenticator: () => result,
          maxReconnects: 0,
        }),
        /authentication callback/,
      );
    }
  } finally {
    await server.cleanup();
  }
});
test("MoonBit NKey envelope and platform Ed25519 signatures interoperate with official NKeys", async () => {
  await loadCore();
  for (let i = 0; i < 8; i++) {
    const pair = createUser(),
      seed = Buffer.from(pair.getSeed()).toString();
    const auth = await nkeyAuthenticator(seed)({
      nonce: "owned-nonce",
      core: command,
    });
    assert.equal(auth.nkey, pair.getPublicKey());
    assert.equal(
      pair.verify(
        Buffer.from("owned-nonce"),
        Buffer.from(auth.sig, "base64url"),
      ),
      true,
    );
    assert.throws(() =>
      command({
        action: "nkey_seed",
        seed: seed.slice(0, -1) + (seed.endsWith("A") ? "B" : "A"),
      }),
    );
  }
});
test("real NATS NKey login rejects wrong identity and reconnect reloads the credential callback", async () => {
  const first = createUser(),
    second = createUser();
  const server = await startServer({
    nkeys: [first.getPublicKey(), second.getPublicKey()],
  });
  let c;
  try {
    const wrong = createUser();
    await assert.rejects(
      Client.connect(server.url, {
        authenticator: nkeyAuthenticator(
          Buffer.from(wrong.getSeed()).toString(),
        ),
        maxReconnects: 0,
      }),
    );
    let current = first,
      calls = 0;
    c = await Client.connect(server.url, {
      authenticator: nkeyAuthenticator(() => {
        calls++;
        return Buffer.from(current.getSeed()).toString();
      }),
    });
    await c.createStream("AUTH", "auth.>");
    current = second;
    await server.restart();
    await c.waitConnected();
    assert.ok(calls >= 2);
    assert.equal((await c.streamInfo("AUTH")).config.name, "AUTH");
    assert.ok(
      !JSON.stringify(c.stats()).includes(
        Buffer.from(first.getSeed()).toString(),
      ),
    );
  } finally {
    c?.close();
    await server.cleanup();
  }
});
test("auth and discovery reject unsafe credentials and do not send secrets to newly advertised hosts", async () => {
  const pool = new ServerPool(["tls://localhost:4222"]);
  pool.discover(["localhost:4223", "untrusted.example:4222"]);
  assert.equal(pool.urls.length, 2);
  assert.throws(() => pool.discover(["attacker@localhost:4223"]));
  assert.throws(
    () => new ServerPool(["tls://localhost:4222", "nats://localhost:4223"]),
  );
  await assert.rejects(
    Client.connect("nats://remote.example:4222", {
      authenticator: nkeyAuthenticator("never used"),
    }),
    /plaintext/,
  );
  await assert.rejects(
    Client.connect("nats://127.0.0.1:1", {
      authenticator: () => ({}),
      token: "mixed",
    }),
  );
  await assert.rejects(
    credentialsAuthenticator(() => Buffer.alloc(100000))({
      core: command,
      nonce: "n",
    }),
    /Credentials/,
  );
  await assert.rejects(
    credentialsAuthenticator(() => Buffer.from("not credentials"))({
      core: command,
      nonce: "n",
    }),
    /Credentials/,
  );
});
