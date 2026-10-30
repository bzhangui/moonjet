import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { Objm } from "@nats-io/obj";
import { Client } from "../platform/client.mjs";
import { startServer } from "../examples/server.mjs";
const exec = promisify(execFile);
test("official nats.js 3.4 exchanges binary Push messages KV CAS tombstones watches and multi-chunk objects", async () => {
  const server = await startServer();
  const c = await Client.connect(server.url);
  const nc = await connect({ servers: server.url });
  try {
    await c.createStream("INTEROP", "interop.>");
    const push = await c.pushSubscribe("INTEROP", "JS_PUSH", {
      config: { filter_subject: "interop.>" },
    });
    const js = jetstream(nc),
      kv = await c.createKeyValue("JS_KV", { maxBytes: 8388608 }),
      store = await c.createObjectStore("JS_OBJ", { maxBytes: 16777216 });
    const referenceKV = await new Kvm(nc).open("JS_KV");
    const referenceObj = await new Objm(nc).open("JS_OBJ");
    const binary = Buffer.from([0, 255, 13, 10, 128, 88]);
    await js.publish("interop.js", binary);
    const received = await push.next();
    assert.deepEqual(received.value.data, binary);
    await received.value.ack();
    push.close();
    const id = await kv.put("moon.key", binary);
    const read = await referenceKV.get("moon.key");
    assert.deepEqual(Buffer.from(read.value), binary);
    assert.equal(String(read.revision), id);
    const newRev = await referenceKV.update(
      "moon.key",
      Buffer.from("JS"),
      Number(id),
    );
    assert.equal((await kv.get("moon.key")).revision, String(newRev));
    await referenceKV.delete("moon.key");
    assert.equal(await kv.get("moon.key"), null);
    await kv.create("moon.key", binary);
    await kv.purge("moon.key");
    assert.equal((await referenceKV.get("moon.key")).operation, "PURGE");
    const data = Buffer.concat([binary, Buffer.alloc(350000, 123)]);
    await store.put("moon.bin", data, { chunkSize: 32768 });
    assert.deepEqual(Buffer.from(await referenceObj.getBlob("moon.bin")), data);
    await referenceObj.putBlob({ name: "reference.bin" }, data);
    assert.deepEqual(await store.getBytes("reference.bin"), data);
    await referenceObj.delete("reference.bin");
    assert.equal(await store.info("reference.bin"), null);
    const manager = await jetstreamManager(nc);
    assert.equal(
      (await manager.consumers.info("INTEROP", "JS_PUSH")).num_ack_pending,
      0,
    );
  } finally {
    c.close();
    await nc.close();
    await server.cleanup();
  }
});
test("official nats.go 1.55 exchanges stream messages KV and Object Store in both directions", async () => {
  const server = await startServer();
  const c = await Client.connect(server.url);
  try {
    await c.createStream("GO_INTEROP", "go.>");
    const kv = await c.createKeyValue("GO_KV", { maxBytes: 8388608 });
    const obj = await c.createObjectStore("GO_OBJ", { maxBytes: 16777216 });
    const binary = Buffer.from([0, 255, 13, 10, 71, 79]);
    const helper = path.resolve(
      ".local/tools/interop-go" + (process.platform === "win32" ? ".exe" : ""),
    );
    // Capture reference output. Auth fixture mode (not used here) contains seeds.
    const produced = await exec(
      helper,
      ["produce", server.url, "GO_INTEROP", "GO_KV", "GO_OBJ", "go.reference"],
      { timeout: 30000, windowsHide: true, maxBuffer: 65536 },
    );
    assert.equal(JSON.parse(produced.stdout).go_produced, true);
    assert.deepEqual(
      (await c.storedMessage("GO_INTEROP", { last_by_subj: "go.reference" }))
        .data,
      binary,
    );
    assert.deepEqual((await kv.get("go.key")).value, binary);
    assert.deepEqual(
      await obj.getBytes("go.bin"),
      Buffer.concat(Array(50000).fill(binary)),
    );
    await c.publish("go.moon", binary, { messageId: "go-moon" });
    await kv.put("moon.key", binary);
    await obj.put("moon.bin", Buffer.concat(Array(50000).fill(binary)));
    const read = await exec(
      helper,
      ["read", server.url, "GO_INTEROP", "GO_KV", "GO_OBJ", "go.moon"],
      { timeout: 30000, windowsHide: true, maxBuffer: 65536 },
    );
    assert.equal(JSON.parse(read.stdout).go_consumed, true);
  } finally {
    c.close();
    await server.cleanup();
  }
});
