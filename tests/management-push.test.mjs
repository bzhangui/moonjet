import test from "node:test";
import assert from "node:assert/strict";
import { Client, command, loadCore } from "../platform/client.mjs";
import { startServer } from "../examples/server.mjs";
async function owned(fn) {
  const server = await startServer();
  const c = await Client.connect(server.url);
  try {
    await fn(c, server);
  } finally {
    c.close();
    await server.cleanup();
  }
}
test("complete management supports configured streams consumer CRUD lists pause purge and exact message selectors", () =>
  owned(async (c) => {
    await c.createStreamConfig({
      name: "FULL",
      subjects: ["full.>"],
      storage: "memory",
      retention: "limits",
      discard: "old",
      num_replicas: 1,
      metadata: { owner: "synthetic" },
      max_msgs: "100",
      max_age: "10000000000",
      allow_direct: true,
    });
    assert.equal(
      (await c.streamInfo("FULL")).config.metadata.owner,
      "synthetic",
    );
    await c.updateStream({
      ...(await c.streamInfo("FULL")).config,
      description: "updated",
    });
    const list = [];
    for await (const s of c.streams()) list.push(s.config.name);
    assert.deepEqual(list, ["FULL"]);
    await c.createConsumerConfig("FULL", {
      name: "NAMED",
      durable_name: "NAMED",
      ack_policy: "explicit",
      filter_subjects: ["full.a", "full.b"],
    });
    await c.updateConsumer("FULL", {
      ...(await c.consumerInfo("FULL", "NAMED")).config,
      description: "changed",
    });
    const consumers = [];
    for await (const x of c.consumers("FULL")) consumers.push(x.name);
    assert.deepEqual(consumers, ["NAMED"]);
    assert.ok((await c.consumerNames("FULL")).consumers.includes("NAMED"));
    assert.ok((await c.streamNames()).streams.includes("FULL"));
    assert.ok((await c.accountInfo()).streams >= 1);
    const first = await c.publish("full.a", Buffer.from("a"), {
      messageId: "a",
    });
    await c.publish("full.b", Buffer.from("b"), { messageId: "b" });
    assert.equal(
      (
        await c.storedMessage("FULL", { last_by_subj: "full.a" })
      ).data.toString(),
      "a",
    );
    await c.pauseConsumer(
      "FULL",
      "NAMED",
      new Date(Date.now() + 60000).toISOString(),
    );
    assert.equal((await c.consumerInfo("FULL", "NAMED")).paused, true);
    await c.resumeConsumer("FULL", "NAMED");
    await c.deleteMessage("FULL", first.sequence);
    await c.purgeStream("FULL", { filter: "full.b" });
    assert.equal((await c.streamInfo("FULL")).state.messages, 0);
    await c.deleteConsumer("FULL", "NAMED");
    await c.deleteStream("FULL");
    await assert.rejects(c.streamInfo("FULL"), /JetStream API error/);
  }));
test("Push consumers receive real binary bytes and confirmed acknowledgements with bounded subscription ownership", () =>
  owned(async (c) => {
    await c.createStream("PUSH", "push.>");
    const push = await c.pushSubscribe("PUSH", "DURABLE", {
      config: {
        filter_subject: "push.>",
        idle_heartbeat: "100000000",
        flow_control: true,
        max_ack_pending: 2,
      },
    });
    await c.publish("push.one", Buffer.from([0, 255, 1]), {
      messageId: "push-1",
    });
    const { value: m } = await push.next();
    assert.deepEqual(m.data, Buffer.from([0, 255, 1]));
    await m.ack();
    assert.equal(m.confirmed, true);
    push.close();
    assert.equal(c.subscriptions.size, 0);
    const rebound = await c.pushSubscribe("PUSH", "DURABLE", { bind: true });
    await c.publish("push.two", Buffer.from("second"), { messageId: "push-2" });
    const next = await rebound.next();
    assert.equal(next.value.data.toString(), "second");
    await next.value.ack();
    await rebound.drain();
  }));
test("queue Push shares one durable group and slow consumers fail without discarding silently", () =>
  owned(async (c, server) => {
    const other = await Client.connect(server.url);
    try {
      await c.createStream("QUEUE", "queue.>");
      const a = await c.pushSubscribe("QUEUE", "SHARED", {
        queue: "workers",
        config: {
          deliver_group: "workers",
          deliver_subject: "delivery.group",
          max_ack_pending: 16,
        },
      });
      const b = await other.pushSubscribe("QUEUE", "SHARED", {
        queue: "workers",
        bind: true,
      });
      for (let i = 0; i < 8; i++)
        await c.publish("queue.one", Buffer.from(String(i)), {
          messageId: "q-" + i,
        });
      const received = new Set();
      for (let i = 0; i < 8; i++) {
        const stream = a.subscription.items.length ? a : b;
        const r = await stream.next();
        received.add(r.value.data.toString());
        await r.value.ack();
      }
      assert.equal(received.size, 8);
      a.close();
      b.close();
      const raw = c.subscribe("bounded", { maxMessages: 1, maxBytes: 4 });
      await raw.ready;
      await c.send("bounded", Buffer.from("123"));
      await c.send("bounded", Buffer.from("456"));
      await assert.rejects(raw.next(), /Slow consumer/);
    } finally {
      other.close();
    }
  }));
test("management preflight rejects unsupported fields mismatched identities and inexact sequence forms", async () => {
  await loadCore();
  for (const args of [
    { operation: "stream.create", stream: "A", options: { name: "B" } },
    {
      operation: "stream.create",
      stream: "A",
      options: { name: "A", misspelled: true },
    },
    {
      operation: "consumer.create",
      stream: "A",
      consumer: "C",
      options: { name: "D" },
    },
    { operation: "message.get", stream: "A", options: { seq: 1.5 } },
  ])
    assert.throws(() => command({ action: "management", ...args }));
  const request = command({
    action: "management",
    operation: "message.get",
    stream: "A",
    options: { seq: "18446744073709551615" },
  });
  assert.ok(request.body.includes("18446744073709551615"));
});
