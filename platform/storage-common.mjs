import { randomUUID } from "node:crypto";
export const unique = () => "MJ" + randomUUID().replaceAll("-", "");
export const text = (b) => new TextDecoder("utf-8", { fatal: true }).decode(b);
export function options(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error("Invalid storage options");
  for (const k of Reflect.ownKeys(value))
    if (!keys.includes(k)) throw new Error("Unknown storage option");
  return value;
}
export function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error("Invalid " + label + " budget");
  return value;
}
export function revision(value) {
  const s = String(value);
  if (
    (typeof value === "number" && !Number.isSafeInteger(value)) ||
    !/^(0|[1-9][0-9]{0,19})$/.test(s) ||
    BigInt(s) > 18446744073709551615n
  )
    throw new Error("Exact revision required");
  return s;
}
export const missing = (e) =>
  /JetStream API error: .*err_code=(10037|10059|10014)\b/.test(e.message);
export function notFound(e) {
  return (
    /no message found|stream not found|consumer not found/i.test(e.message) ||
    missing(e)
  );
}
export async function latest(client, stream, subject) {
  try {
    return await client.storedMessage(stream, { last_by_subj: subject });
  } catch (e) {
    if (/JetStream API error: .*err_code=10037\b/.test(e.message)) return null;
    throw e;
  }
}
// A consistent finite history is fenced by the stream's current sequence. No
// growing source or timeout is mistaken for successful enumeration.
export async function* snapshot(
  client,
  stream,
  filter,
  { last = false, maxEntries = 100000, signal } = {},
) {
  integer(maxEntries, 1, 100000, "snapshot entries");
  const before = await client.streamInfo(stream);
  const fence = BigInt(before.state.last_seq || 0);
  const name = unique();
  let created = false,
    complete = false;
  try {
    const info = await client.createConsumerConfig(stream, {
      name,
      durable_name: name,
      filter_subject: filter,
      deliver_policy: last ? "last_per_subject" : "all",
      ack_policy: "explicit",
      max_ack_pending: 256,
      inactive_threshold: "30000000000",
    });
    created = true;
    let remaining = BigInt(info.num_pending || 0),
      count = 0;
    if (remaining > BigInt(maxEntries))
      throw new Error("Snapshot entry budget exceeded");
    while (remaining > 0n) {
      if (signal?.aborted) throw new Error("Storage operation aborted");
      const batch = await client.fetch(stream, name, {
        batch: Number(remaining > 32n ? 32n : remaining),
        expiresMs: 1000,
        maxBytes: 8388608,
      });
      if (!batch.length)
        throw new Error(
          "Snapshot incomplete; consumer expired or source changed",
        );
      for (const m of batch) {
        if (BigInt(m.metadata.stream_sequence) > fence)
          throw new Error("Snapshot changed during enumeration; retry");
        if (++count > maxEntries)
          throw new Error("Snapshot entry budget exceeded");
        await m.ack();
        remaining--;
        yield m;
      }
    }
    complete = true;
  } finally {
    if (created) {
      try {
        await client.deleteConsumer(stream, name);
      } catch (e) {
        if (complete && !notFound(e))
          throw new Error("Snapshot consumer cleanup failed");
      }
    }
  }
}
export async function watch(
  client,
  stream,
  filter,
  decode,
  {
    history = false,
    includeInitial = true,
    maxMessages = 256,
    maxBytes = 8388608,
    signal,
  } = {},
) {
  const subscription = await client.pushSubscribe(stream, "", {
    config: {
      filter_subject: filter,
      deliver_policy: includeInitial
        ? history
          ? "all"
          : "last_per_subject"
        : "new",
      ack_policy: "explicit",
      idle_heartbeat: "5000000000",
      flow_control: true,
      inactive_threshold: "30000000000",
      max_ack_pending: 256,
    },
    maxMessages,
    maxBytes,
    signal,
  });
  let initialRemaining = includeInitial
    ? BigInt(subscription.info.num_pending || 0) +
      BigInt(subscription.info.delivered?.consumer_seq || 0)
    : 0n;
  let initialized = initialRemaining === 0n;
  let emitInit = initialized,
    closed = false;
  const generation = client.generation;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      try {
        if (closed) return { done: true };
        if (client.generation !== generation)
          throw new Error("Watch continuity lost; restart a fresh snapshot");
        if (emitInit) {
          emitInit = false;
          return { value: { initialized: true }, done: false };
        }
        const r = await subscription.next();
        if (r.done) {
          await this.close();
          return r;
        }
        if (client.generation !== generation)
          throw new Error("Watch continuity lost; restart a fresh snapshot");
        const value = decode(r.value);
        await r.value.ack();
        if (!initialized && --initialRemaining === 0n) {
          initialized = true;
          emitInit = true;
        }
        return { value, done: false };
      } catch (error) {
        try {
          await this.close();
        } catch {}
        throw error;
      }
    },
    async return() {
      await this.close();
      return { done: true };
    },
    async close() {
      if (closed) return;
      closed = true;
      subscription.close();
      try {
        await client.deleteConsumer(stream, subscription.consumer);
      } catch (e) {
        if (client.status === "connected" && !notFound(e)) throw e;
      }
    },
  };
}
