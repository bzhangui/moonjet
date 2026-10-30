import test from "node:test";
import assert from "node:assert/strict";
import { Client, command, loadCore } from "../platform/client.mjs";
import { startServer } from "../examples/server.mjs";

test("JetStream readiness retries only transient reads, never writes or authorization failures", async () => {
  await loadCore();
  const c = new Client("nats://127.0.0.1:1");
  let reads = 0;
  try {
    c.streamInfo = async () => {
      if (++reads < 3) throw new Error("NATS response status 503");
      return { cluster: { leader: "owned" } };
    };
    assert.equal(
      (await c.waitJetStream({ stream: "S", timeout: 1000 })).cluster.leader,
      "owned",
    );
    assert.equal(reads, 3);
    assert.equal(c.stats().published, 0);
    c.streamInfo = async () => {
      throw new Error("JetStream API error: code=403 err_code=99999");
    };
    await assert.rejects(c.waitJetStream({ stream: "S" }), /403/);
    await assert.rejects(
      c.waitJetStream({ stream: "S", signal: AbortSignal.abort() }),
      /aborted/,
    );
    await assert.rejects(c.waitJetStream({ consumer: "C" }), /requires/);
    await assert.rejects(c.waitJetStream({ timeout: 1 }), /budget/);
  } finally {
    c.close();
  }
});
test("watch restart fencing cancellation early iterator return and malformed manifests clean owned resources", async () => {
  const s = await startServer();
  const c = await Client.connect(s.url);
  try {
    const kv = await c.createKeyValue("WATCH", { maxBytes: 8388608 });
    const watch = await kv.watch();
    await watch.next();
    await s.restart();
    await c.waitConnected();
    await assert.rejects(watch.next(), /continuity/);
    assert.equal(c.subscriptions.size, 0);
    assert.equal((await c.consumerNames(kv.stream)).consumers.length, 0);
    const controller = new AbortController();
    const cancelled = await kv.watch(">", {
      includeInitial: false,
      signal: controller.signal,
    });
    await cancelled.next();
    controller.abort();
    assert.equal((await cancelled.next()).done, true);
    assert.equal((await c.consumerNames(kv.stream)).consumers.length, 0);
    const obj = await c.createObjectStore("CANCEL", { maxBytes: 16777216 });
    await obj.put("x", Buffer.alloc(400000, 3), { chunkSize: 32000 });
    const r = await obj.get("x");
    for await (const b of r.data) {
      assert.ok(b.length);
      break;
    }
    assert.equal((await c.consumerNames(obj.stream)).consumers.length, 0);
    const abort = AbortSignal.abort();
    await assert.rejects(
      c.pushSubscribe("OBJ_CANCEL", "BAD", { signal: abort }),
      /aborted/,
    );
    await assert.rejects(
      c.snapshotStream("OBJ_CANCEL", { signal: abort }),
      /aborted/,
    );
    assert.equal(c.subscriptions.size, 0);
    const info = await obj.info("x");
    const msubject =
      "$O.CANCEL.M." +
      Buffer.from("x")
        .toString("base64")
        .replaceAll("+", "-")
        .replaceAll("/", "_");
    await c.publish(
      msubject,
      Buffer.from(JSON.stringify({ ...info, digest: "SHA-256=invalid" })),
      {
        messageId: "bad-metadata",
        headers: [{ name: "Nats-Rollup", value: "sub" }],
      },
    );
    await assert.rejects(obj.getBytes("x"), /digest/);
    const malformed = { ...info };
    delete malformed.nuid;
    await c.publish(msubject, Buffer.from(JSON.stringify(malformed)), {
      messageId: "missing-chunk-id",
      headers: [{ name: "Nats-Rollup", value: "sub" }],
    });
    await assert.rejects(
      obj.garbageCollect({ dryRun: false, confirmQuiescent: true }),
      /chunk identifier/,
    );
  } finally {
    c.close();
    await s.cleanup();
  }
});
test("deterministic configuration boundary corpus rejects mutation integer overflow controls and silent option downgrades", async () => {
  await loadCore();
  const bad = [
    null,
    [],
    { typo: 1 },
    { name: "bad\nname" },
    { subjects: ["a..b"] },
    { max_msgs: 0.5 },
    { max_bytes: NaN },
    { max_age: 9007199254740992 },
    { num_replicas: "18446744073709551616" },
  ];
  for (const value of bad)
    assert.throws(() =>
      command({ action: "configuration", kind: "stream", value }),
    );
  for (let i = 0; i < 32; i++)
    assert.throws(() =>
      command({
        action: "kv_subject",
        bucket: "B",
        key: "bad" + String.fromCharCode(i) + "key",
      }),
    );
  for (const source of [
    '{"x":1,"x":2}',
    '{"x":{"y":1},"x":0}',
    '{"size":18446744073709551616} trailing',
  ])
    assert.throws(() => command({ action: "response", source }));
  const c = new Client("nats://127.0.0.1:1");
  try {
    for (const options of [
      null,
      [],
      { bind: "yes" },
      { [Symbol("bind")]: true },
      { config: { unknown: true } },
    ])
      await assert.rejects(c.pushSubscribe("A", "C", options));
    assert.throws(() => c.deleteMessage("A", 9007199254740992), /Exact/);
  } finally {
    c.close();
  }
});
