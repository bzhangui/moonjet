import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client, command, loadCore } from "../platform/client.mjs";
import { startServer } from "../examples/server.mjs";
test("snapshot restores exact data consumer state and refuses wrong identity and bounded overflows", async () => {
  const s = await startServer();
  const c = await Client.connect(s.url);
  try {
    await c.createStream("BACKUP", "backup.>");
    await c.createConsumer("BACKUP", "D", "backup.>");
    const payload = Buffer.alloc(200000, 177);
    await c.publish("backup.bin", payload, { messageId: "backup" });
    const [m] = await c.fetch("BACKUP", "D");
    await m.ack();
    const backup = await c.snapshotStream("BACKUP");
    assert.ok(backup.data.length > 0);
    assert.equal(c.subscriptions.size, 0);
    await assert.rejects(c.restoreStream("OTHER", backup), /identity/);
    await assert.rejects(c.snapshotStream("BACKUP", { maxBytes: 1 }), /budget/);
    await c.deleteStream("BACKUP");
    await c.restoreStream("BACKUP", backup);
    assert.deepEqual(
      (await c.storedMessage("BACKUP", { last_by_subj: "backup.bin" })).data,
      payload,
    );
    assert.equal((await c.consumerInfo("BACKUP", "D")).num_ack_pending, 0);
    assert.equal((await c.fetch("BACKUP", "D", { expiresMs: 50 })).length, 0);
  } finally {
    c.close();
    await s.cleanup();
  }
});
test("Push AckNone AckAll policies and drain preserve buffered deliveries", async () => {
  const s = await startServer();
  const c = await Client.connect(s.url);
  try {
    await c.createStream("POLICIES", "policies.>");
    const none = await c.pushSubscribe("POLICIES", "NONE", {
      config: { ack_policy: "none" },
    });
    await c.publish("policies.one", Buffer.from("one"), { messageId: "none" });
    const n = await none.next();
    assert.equal(n.value.ackPolicy, "none");
    await assert.rejects(n.value.ack(), /AckNone/);
    none.close();
    const all = await c.pushSubscribe("POLICIES", "ALL", {
      config: { ack_policy: "all" },
    });
    await c.publish("policies.two", Buffer.from("two"), { messageId: "all" });
    await all.drain();
    const received = [];
    for await (const m of all) {
      received.push(m.data.toString());
      await m.ack();
    }
    assert.deepEqual(received, ["one", "two"]);
    assert.equal((await c.consumerInfo("POLICIES", "ALL")).num_ack_pending, 0);
  } finally {
    c.close();
    await s.cleanup();
  }
});
test("TLS-first with mutual certificate verification accepts owned cert and rejects absent credentials", async () => {
  const parent = fs.realpathSync(os.tmpdir()),
    base = fs.mkdtempSync(path.join(parent, "moonjet-mtls-")),
    cert = path.join(base, "cert.pem"),
    key = path.join(base, "key.pem");
  let s, c;
  try {
    const generation = spawnSync(
      process.env.OPENSSL || "openssl",
      [
        "req",
        "-config",
        fileURLToPath(new URL("./openssl.cnf", import.meta.url)),
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(generation.status, 0, "OpenSSL required");
    for (const handshakeFirst of [true, false]) {
      s = await startServer({
        tls: { cert, key, ca: cert, verify: true, handshakeFirst },
      });
      const url = s.url.replace("nats:", "tls:");
      const opts = {
        serverName: "localhost",
        ca: fs.readFileSync(cert),
        tlsHandshakeFirst: handshakeFirst,
        maxReconnects: 0,
      };
      await assert.rejects(Client.connect(url, opts));
      c = await Client.connect(url, {
        ...opts,
        cert: fs.readFileSync(cert),
        key: fs.readFileSync(key),
      });
      assert.ok(await c.accountInfo());
      c.close();
      c = null;
      await s.cleanup();
      s = null;
    }
  } finally {
    c?.close();
    await s?.cleanup();
    if (
      path.dirname(base) !== parent ||
      !path.basename(base).startsWith("moonjet-mtls-")
    )
      throw new Error("Unsafe TLS cleanup");
    fs.rmSync(base, { recursive: true, force: true });
  }
});
test("response counters and nested integer settings never silently round at the JS boundary", async () => {
  await loadCore();
  assert.equal(
    command({
      action: "response",
      source: '{"messages":9007199254740993,"bytes":18446744073709551615}',
    }).messages,
    "9007199254740993",
  );
  assert.throws(
    () =>
      command({
        action: "configuration",
        kind: "stream",
        config: { max_bytes: 9007199254740992 },
      }),
    /exact integers/,
  );
});
