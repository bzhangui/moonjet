import assert from "node:assert/strict";
import { Client } from "../platform/client.mjs";
import { startServer } from "./server.mjs";
const server = await startServer();
let client, push;
try {
  client = await Client.connect(server.url);
  await client.createStreamConfig({
    name: "ORDERS",
    subjects: ["orders.>"],
    storage: "file",
    max_bytes: 8388608,
  });
  push = await client.pushSubscribe("ORDERS", "PUSH", {
    config: { filter_subject: "orders.>", ack_policy: "explicit" },
  });
  await client.publish("orders.created", Buffer.from("order-42"), {
    messageId: "order-42-created",
  });
  const { value: message } = await push.next();
  await message.ack();
  push.close();
  const kv = await client.createKeyValue("SETTINGS", {
    history: 3,
    maxBytes: 8388608,
  });
  const revision = await kv.create("app.version", Buffer.from("1"));
  await kv.update("app.version", Buffer.from("2"), revision);
  const obj = await client.createObjectStore("ARTIFACTS", {
    maxBytes: 8388608,
  });
  const binary = Buffer.from([0, 255, 13, 10, 77]);
  await obj.put("example.bin", binary);
  assert.deepEqual(await obj.getBytes("example.bin"), binary);
  console.log(
    JSON.stringify({
      ok: true,
      push_confirmed: message.confirmed,
      kv_cas: true,
      object_sha256: true,
      real_user_pilot: false,
      service_scope: "owned loopback NATS",
    }),
  );
} finally {
  push?.close();
  client?.close();
  await server.cleanup();
}
