import test from "node:test";
import assert from "node:assert/strict";
import { Client, command, loadCore } from "../platform/client.mjs";
import { startServer } from "../examples/server.mjs";
async function owned(fn) {
  const s = await startServer();
  const c = await Client.connect(s.url);
  try {
    await fn(c, s);
  } finally {
    c.close();
    await s.cleanup();
  }
}
async function array(it) {
  const result = [];
  for await (const v of it) result.push(v);
  return result;
}
test("KV binary CAS history delete purge recreate keys and watcher lifecycle", () =>
  owned(async (c) => {
    const kv = await c.createKeyValue("CACHE", {
      history: 4,
      storage: "memory",
      maxBytes: 8388608,
    });
    const w = await kv.watch();
    assert.deepEqual((await w.next()).value, { initialized: true });
    const first = await kv.create("one.key", Buffer.from([0, 255]));
    assert.equal((await w.next()).value.revision, first);
    await assert.rejects(kv.create("one.key", Buffer.from("bad")), /10071/);
    assert.throws(
      () => kv.update("one.key", Buffer.from("bad"), "0"),
      /positive/,
    );
    const second = await kv.update("one.key", Buffer.from("second"), first);
    await assert.rejects(
      kv.update("one.key", Buffer.from("stale"), first),
      /10071/,
    );
    assert.equal((await kv.get("one.key")).revision, second);
    assert.deepEqual(
      (await kv.get("one.key", { revision: first })).value,
      Buffer.from([0, 255]),
    );
    assert.equal((await array(kv.history("one.key"))).length, 2);
    await kv.delete("one.key");
    assert.equal(await kv.get("one.key"), null);
    assert.equal(
      (await kv.get("one.key", { includeDeleted: true })).operation,
      "DEL",
    );
    await kv.create("one.key", Buffer.from("again"));
    await kv.put("two", Buffer.from("2"));
    const initial = await kv.watch();
    const initialKeys = [];
    for (let i = 0; i < 3; i++) {
      const e = (await initial.next()).value;
      if (e.initialized) {
        assert.equal(i, 2);
        break;
      }
      initialKeys.push(e.key);
    }
    assert.deepEqual(initialKeys.sort(), ["one.key", "two"]);
    await initial.close();
    assert.deepEqual((await array(kv.keys())).sort(), ["one.key", "two"]);
    await kv.purge("one.key");
    assert.equal((await array(kv.history("one.key"))).length, 1);
    assert.deepEqual(await array(kv.keys()), ["two"]);
    await w.close();
    assert.equal(c.subscriptions.size, 0);
    assert.equal((await c.consumerNames(kv.stream)).consumers.length, 0);
    await kv.updateConfig({ description: "updated", history: 3 });
    assert.equal((await kv.status()).config.description, "updated");
    await kv.destroy();
  }));
test("KV TTL and empty snapshots are bounded, malformed keys/revisions fail before network mutation", () =>
  owned(async (c) => {
    const kv = await c.createKeyValue("TTL", {
      ttlMs: 120,
      storage: "memory",
      maxBytes: 8388608,
    });
    assert.deepEqual(await array(kv.keys()), []);
    assert.equal(await kv.get("absent"), null);
    await kv.put("x", Buffer.from("x"));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await kv.get("x"), null);
    for (const key of ["a.*", "a..b", "bad space"])
      await assert.rejects(kv.put(key, Buffer.alloc(0)));
    await assert.rejects(
      kv.put("x", Buffer.alloc(0), { previousRevision: 9007199254740992 }),
      /Exact/,
    );
    await assert.rejects(c.createKeyValue("bad.dot"));
  }));
test("Object Store streams binary chunks verifies digest supports empty metadata links list watch delete and seal", () =>
  owned(async (c) => {
    const store = await c.createObjectStore("FILES", {
      storage: "memory",
      maxBytes: 8388608,
    });
    const w = await store.watch();
    assert.equal((await w.next()).value.initialized, true);
    const data = Buffer.alloc(400003);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    async function* source() {
      yield data.subarray(0, 3);
      yield data.subarray(3, 250007);
      yield data.subarray(250007);
    }
    const info = await store.put("中文/data.bin", source(), {
      chunkSize: 65536,
    });
    assert.equal(info.chunks, 7);
    assert.equal((await w.next()).value.name, "中文/data.bin");
    assert.deepEqual(await store.getBytes(info.name), data);
    await store.put("empty", Buffer.alloc(0));
    assert.deepEqual(await store.getBytes("empty"), Buffer.alloc(0));
    await store.updateMetadata(info.name, { description: "changed" });
    assert.equal((await store.info(info.name)).description, "changed");
    await store.link("alias", "FILES", info.name);
    assert.deepEqual(await store.getBytes("alias"), data);
    assert.equal((await array(store.list())).length, 3);
    await store.delete("empty");
    assert.equal(await store.info("empty"), null);
    assert.equal((await array(store.list())).length, 2);
    await w.close();
    await store.seal();
    await assert.rejects(
      store.put("sealed", Buffer.from("x")),
      /JetStream API error/,
    );
  }));
test("Object upload limits aborts stale CAS tamper truncation link cycles and leaked consumers fail closed", () =>
  owned(async (c) => {
    const store = await c.createObjectStore("FAULTS", {
      storage: "memory",
      maxBytes: 8388608,
    });
    await assert.rejects(
      store.put("big", Buffer.alloc(4), { maxBytes: 3 }),
      /budget/,
    );
    assert.equal(await store.info("big"), null);
    await assert.rejects(
      store.put("abort", Buffer.from("a"), { signal: AbortSignal.abort() }),
      /aborted/,
    );
    const first = await store.put("x", Buffer.from("first"));
    await store.put("x", Buffer.from("second"));
    await assert.rejects(
      store.put("x", Buffer.from("stale"), {
        previousRevision: first.revision,
      }),
      /10071/,
    );
    assert.equal((await store.getBytes("x")).toString(), "second");
    const audit = await store.garbageCollect();
    assert.ok(audit.orphanGenerations >= 1);
    assert.equal(audit.purged, 0);
    await assert.rejects(
      store.garbageCollect({ dryRun: false }),
      /Quiescent|quiescent/,
    );
    assert.ok(
      (await store.garbageCollect({ dryRun: false, confirmQuiescent: true }))
        .purged >= 1,
    );
    assert.equal((await store.getBytes("x")).toString(), "second");
    const info = await store.info("x");
    const subject = "$O.FAULTS.C." + info.nuid;
    await c.purgeStream(store.stream, { filter: subject });
    await c.publish(subject, Buffer.from("broken"), { messageId: "corrupt" });
    await assert.rejects(store.getBytes("x"), /integrity/);
    await assert.rejects(store.getBytes("x", { maxBytes: 1 }), /budget/);
    assert.equal((await c.consumerNames(store.stream)).consumers.length, 0);
    await store.put("target", Buffer.from("t"));
    await store.link("link", "FAULTS", "target");
    await assert.rejects(store.link("chain", "FAULTS", "link"), /another link/);
    await assert.rejects(store.put("bad\0name", Buffer.alloc(0)), /name/);
  }));
test("portable storage guards reject malformed headers and object manifest identity", async () => {
  await loadCore();
  const base = {
    name: "x",
    bucket: "B",
    size: 0,
    chunks: 0,
    digest: "SHA-256=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  };
  for (const changes of [
    { deleted: "false" },
    { size: "0" },
    { options: [] },
    { options: { link: { bucket: "bad.dot" } } },
    { nuid: "bad.dot" },
  ])
    assert.throws(() =>
      command({
        action: "object_info",
        bucket: "B",
        name: "x",
        info: { ...base, ...changes },
      }),
    );
  assert.throws(() =>
    command({ action: "stored_headers", source: "NATS/1.0\r\nBad\r\n\r\n" }),
  );
  assert.throws(() =>
    command({
      action: "object_info",
      bucket: "B",
      name: "x",
      info: {
        name: "wrong",
        bucket: "B",
        size: 0,
        chunks: 0,
        digest: "SHA-256=",
      },
    }),
  );
});
