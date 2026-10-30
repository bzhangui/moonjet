import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "../platform/client.mjs";
import { startCluster } from "./cluster-fixture.mjs";

async function available(operation) {
  const deadline = performance.now() + 15000;
  for (;;) {
    try {
      return await operation();
    } catch (e) {
      if (
        performance.now() > deadline ||
        !/NATS response status 503|Request timeout|err_code=(10008|10009|10004)\b/.test(
          e.message,
        )
      )
        throw e;
      await delay(150);
    }
  }
}

async function nextWithin(push) {
  let timer;
  try {
    return await Promise.race([
      push.next(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Push delivery deadline exceeded")),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
test("real three-node cluster discovery preserves durable Push subscriptions after a hard node exit", async () => {
  const cluster = await startCluster();
  let c;
  try {
    c = await Client.connect(cluster.urls[0], {
      timeout: 3000,
      maxReconnects: 20,
    });
    for (let attempt = 0; ; attempt++) {
      try {
        await c.createStreamConfig({
          name: "REPLICATED",
          subjects: ["ha.>"],
          storage: "file",
          num_replicas: 3,
        });
        break;
      } catch (error) {
        if (attempt >= 15) throw error;
        await delay(200);
      }
    }
    assert.ok(c.pool.urls.length >= 3);
    assert.equal((await c.stepDownStream("REPLICATED")).success, true);
    await c.waitJetStream({ stream: "REPLICATED" });
    for (let i = 0; i < 30; i++) {
      try {
        await c.streamInfo("REPLICATED");
        break;
      } catch (e) {
        if (i === 29) throw e;
        await delay(200);
      }
    }
    const push = await available(() =>
      c.pushSubscribe("REPLICATED", "DURABLE", {
        config: {
          filter_subject: "ha.>",
          ack_wait: "1000000000",
          num_replicas: 3,
          deliver_subject: "_INBOX.CLUSTER_" + cluster.members[0].port,
        },
      }),
    );
    await available(() =>
      c.publish("ha.one", Buffer.from("before"), { messageId: "before" }),
    );
    const old = await nextWithin(push);
    assert.equal(old.value.data.toString(), "before");
    const gone = once(c, "disconnected");
    await cluster.stop(0);
    await gone;
    await c.waitConnected(15000);
    await c.waitJetStream({ stream: "REPLICATED", consumer: "DURABLE" });
    assert.notEqual(Number(c.endpoint.port), cluster.members[0].port);
    await assert.rejects(old.value.ack(), /Stale/);
    const redelivered = await nextWithin(push);
    assert.equal(redelivered.value.data.toString(), "before");
    await redelivered.value.ack();
    await available(() =>
      c.publish("ha.two", Buffer.from("after"), { messageId: "after" }),
    );
    // At-least-once permits acknowledged messages to reappear across failover.
    // Settle duplicates by business identity; never demand exactly-once here.
    let found = false;
    for (let i = 0; i < 16; i++) {
      const fresh = await nextWithin(push);
      const body = fresh.value.data.toString();
      assert.ok(["before", "after"].includes(body));
      await fresh.value.ack();
      if (body === "after") {
        found = true;
        break;
      }
      assert.equal(
        fresh.value.metadata.stream_sequence,
        old.value.metadata.stream_sequence,
      );
    }
    assert.equal(found, true);
    assert.equal((await c.streamInfo("REPLICATED")).config.num_replicas, 3);
    push.close();
  } finally {
    c?.close();
    await cluster.cleanup();
  }
});
test("initial seed failure falls through to the next authorized endpoint", async () => {
  const cluster = await startCluster();
  let c;
  try {
    await cluster.stop(0);
    c = await Client.connect([cluster.urls[0], cluster.urls[1]], {
      timeout: 1000,
    });
    assert.equal(Number(c.endpoint.port), cluster.members[1].port);
  } finally {
    c?.close();
    await cluster.cleanup();
  }
});

test("replicated stream loses quorum without false PubAck and recovers on an owned node restart", async () => {
  const cluster = await startCluster();
  let c;
  try {
    c = await Client.connect(cluster.urls[0], {
      timeout: 1500,
      maxReconnects: 20,
    });
    for (let attempt = 0; ; attempt++) {
      try {
        await c.createStreamConfig({
          name: "QUORUM",
          subjects: ["quorum.>"],
          storage: "file",
          num_replicas: 3,
        });
        break;
      } catch (e) {
        if (attempt >= 20) throw e;
        await delay(200);
      }
    }
    await available(() =>
      c.publish("quorum.one", Buffer.from("confirmed"), {
        messageId: "confirmed",
      }),
    );
    await cluster.stop(1);
    await cluster.stop(2);
    await delay(500);
    const before = c.stats().published;
    await assert.rejects(
      c.publish("quorum.two", Buffer.from("uncertain"), {
        messageId: "uncertain",
      }),
    );
    assert.equal(c.stats().published, before);
    await cluster.restart(1);
    await c.waitJetStream({ stream: "QUORUM", timeout: 30000 });
    const result = await available(() =>
      c.publish("quorum.two", Buffer.from("uncertain"), {
        messageId: "uncertain",
      }),
    );
    assert.ok(result.sequence);
    assert.equal(
      (
        await available(() =>
          c.storedMessage("QUORUM", { last_by_subj: "quorum.one" }),
        )
      ).data.toString(),
      "confirmed",
    );
    assert.equal(c.pending.size, 0);
  } finally {
    c?.close();
    await cluster.cleanup();
  }
});
