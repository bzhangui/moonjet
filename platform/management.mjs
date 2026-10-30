import { randomUUID } from "node:crypto";
import { options as checked, integer, revision } from "./storage-common.mjs";
const jsonText = (bytes) =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const name = () => "MJ_" + randomUUID().replaceAll("-", "");
export function installManagement(Client, Message, command, interpret) {
  Object.assign(Client.prototype, {
    async management(operation, stream = "", consumer = "", options = {}) {
      const req = command({
        action: "management",
        operation,
        stream,
        consumer,
        options,
        prefix: this.options.apiPrefix || "$JS.API",
      });
      const bytes = await this.request(req.subject, Buffer.from(req.body));
      return interpret(this, () =>
        command({ action: "response", source: jsonText(bytes) }),
      );
    },
    accountInfo() {
      return this.management("account.info");
    },
    async waitJetStream(opts = {}) {
      checked(opts, ["stream", "consumer", "timeout", "signal"]);
      const timeout = integer(
        opts.timeout ?? 15000,
        50,
        60000,
        "JetStream readiness",
      );
      if (opts.consumer && !opts.stream)
        throw new Error("Readiness consumer requires a stream");
      const deadline = performance.now() + timeout;
      while (performance.now() < deadline) {
        if (opts.signal?.aborted) throw new Error("Readiness aborted");
        if (this.closed) throw new Error("Client closed");
        try {
          const info = opts.stream
            ? await this.streamInfo(opts.stream)
            : await this.accountInfo();
          if (info.cluster && !info.cluster.leader)
            throw new Error("Election pending");
          if (opts.consumer) {
            const consumer = await this.consumerInfo(
              opts.stream,
              opts.consumer,
            );
            if (consumer.cluster && !consumer.cluster.leader)
              throw new Error("Election pending");
          }
          return info;
        } catch (e) {
          if (
            !/Election pending|Disconnected|NATS response status 503|Request timeout|Connection lost|err_code=(10008|10009|10004)\b/.test(
              e.message,
            )
          )
            throw e;
        }
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(100, Math.max(1, deadline - performance.now())),
          ),
        );
      }
      throw new Error(
        "JetStream readiness deadline exceeded; no write was retried",
      );
    },
    streamInfo(stream, options = {}) {
      return this.management("stream.info", stream, "", options);
    },
    stepDownStream(stream, options = {}) {
      return this.management("stream.leader.stepdown", stream, "", options);
    },
    stepDownConsumer(stream, consumer) {
      return this.management("consumer.leader.stepdown", stream, consumer);
    },
    removeStreamPeer(stream, peer) {
      return this.management("stream.peer.remove", stream, "", { peer });
    },
    cancelStreamMove(stream) {
      return this.management("stream.cancel.move", stream);
    },
    async snapshotStream(stream, opts = {}) {
      checked(opts, [
        "maxBytes",
        "timeout",
        "noConsumers",
        "chunkSize",
        "signal",
      ]);
      const maxBytes = integer(
        opts.maxBytes ?? 67108864,
        1,
        1073741824,
        "snapshot bytes",
      );
      const timeout = integer(
        opts.timeout ?? 10000,
        50,
        30000,
        "snapshot timeout",
      );
      const chunkSize = integer(
        opts.chunkSize ?? 32768,
        1024,
        262144,
        "snapshot chunk",
      );
      if (
        opts.noConsumers !== undefined &&
        typeof opts.noConsumers !== "boolean"
      )
        throw new Error("Invalid noConsumers");
      if (opts.signal?.aborted) throw new Error("Snapshot aborted");
      const subject = "_INBOX." + name();
      const sub = this.subscribe(subject, {
        maxMessages: 256,
        maxBytes: 8388608,
        signal: opts.signal,
      });
      let timer;
      const parts = [];
      let size = 0;
      try {
        await sub.ready;
        const info = await this.management("stream.snapshot", stream, "", {
          deliver_subject: subject,
          no_consumers: opts.noConsumers ?? false,
          chunk_size: chunkSize,
          window_size: 1048576,
          jsck: true,
        });
        timer = setTimeout(
          () => sub.fail(new Error("Snapshot deadline exceeded")),
          timeout,
        );
        for await (const m of sub) {
          if (opts.signal?.aborted) throw new Error("Snapshot aborted");
          if (!m.data.length)
            return {
              config: info.config,
              state: info.state,
              data: Buffer.concat(parts),
            };
          size += m.data.length;
          if (size > maxBytes) throw new Error("Snapshot byte budget exceeded");
          parts.push(m.data);
          if (m.reply) {
            if (!m.reply.startsWith("$JS.SNAPSHOT.ACK."))
              throw new Error("Unexpected snapshot ACK route");
            await this.send(m.reply);
          }
        }
        throw new Error("Snapshot incomplete");
      } finally {
        clearTimeout(timer);
        sub.close();
      }
    },
    async restoreStream(stream, snapshot, opts = {}) {
      checked(opts, ["chunkSize", "maxBytes", "signal"]);
      const chunkSize = integer(
        opts.chunkSize ?? 32768,
        1024,
        262144,
        "restore chunk",
      );
      const maxBytes = integer(
        opts.maxBytes ?? 67108864,
        1,
        1073741824,
        "restore bytes",
      );
      if (
        !snapshot ||
        !Buffer.isBuffer(snapshot.data) ||
        snapshot.data.length > maxBytes ||
        snapshot.config?.name !== stream ||
        !snapshot.state
      )
        throw new Error("Invalid restore snapshot identity or budget");
      if (opts.signal?.aborted) throw new Error("Restore aborted");
      const info = await this.management("stream.restore", stream, "", {
        config: snapshot.config,
        state: snapshot.state,
      });
      if (
        typeof info.deliver_subject !== "string" ||
        !info.deliver_subject.startsWith("$JS.SNAPSHOT.RESTORE.")
      )
        throw new Error("Invalid restore delivery route");
      for (let i = 0; i < snapshot.data.length; i += chunkSize) {
        if (opts.signal?.aborted)
          throw new Error(
            "Restore aborted; server-side restore may be incomplete",
          );
        const ack = await this.request(
          info.deliver_subject,
          snapshot.data.subarray(i, i + chunkSize),
        );
        if (ack.length) throw new Error("Restore chunk rejected");
      }
      const response = await this.request(
        info.deliver_subject,
        Buffer.alloc(0),
      );
      return interpret(this, () =>
        command({ action: "response", source: jsonText(response) }),
      );
    },
    createStreamConfig(config) {
      return this.management("stream.create", config?.name, "", config);
    },
    updateStream(config) {
      return this.management("stream.update", config?.name, "", config);
    },
    deleteStream(stream) {
      return this.management("stream.delete", stream);
    },
    purgeStream(stream, options = {}) {
      return this.management("stream.purge", stream, "", options);
    },
    listStreams(options = {}) {
      return this.management("streams.list", "", "", options);
    },
    streamNames(options = {}) {
      return this.management("streams.names", "", "", options);
    },
    async *streams(options = {}) {
      let offset = 0,
        total = Infinity;
      for (let page = 0; offset < total && page < 4096; page++) {
        const result = await this.listStreams({ ...options, offset });
        total = Number(result.total);
        if (!Number.isSafeInteger(total) || !Array.isArray(result.streams))
          throw new Error("Malformed stream pagination");
        if (!result.streams.length) {
          if (offset < total) throw new Error("Stream pagination stalled");
          return;
        }
        for (const entry of result.streams) yield entry;
        offset += result.streams.length;
      }
      if (offset < total) throw new Error("Stream pagination budget");
    },
    createConsumerConfig(stream, config) {
      return this.management(
        "consumer.create",
        stream,
        config?.name || config?.durable_name || "",
        config,
      );
    },
    updateConsumer(stream, config) {
      return this.management(
        "consumer.update",
        stream,
        config?.name || config?.durable_name || "",
        config,
      );
    },
    deleteConsumer(stream, consumer) {
      return this.management("consumer.delete", stream, consumer);
    },
    consumerInfo(stream, consumer) {
      return this.management("consumer.info", stream, consumer);
    },
    listConsumers(stream, options = {}) {
      return this.management("consumers.list", stream, "", options);
    },
    consumerNames(stream, options = {}) {
      return this.management("consumers.names", stream, "", options);
    },
    async *consumers(stream) {
      let offset = 0,
        total = Infinity;
      for (let page = 0; offset < total && page < 4096; page++) {
        const r = await this.listConsumers(stream, { offset });
        total = Number(r.total);
        if (!Number.isSafeInteger(total) || !Array.isArray(r.consumers))
          throw new Error("Malformed consumer pagination");
        if (!r.consumers.length) {
          if (offset < total) throw new Error("Consumer pagination stalled");
          return;
        }
        for (const x of r.consumers) yield x;
        offset += r.consumers.length;
      }
      if (offset < total) throw new Error("Consumer pagination budget");
    },
    pauseConsumer(stream, consumer, pauseUntil) {
      return this.management("consumer.pause", stream, consumer, {
        pause_until: pauseUntil,
      });
    },
    resumeConsumer(stream, consumer) {
      return this.pauseConsumer(stream, consumer, "0001-01-01T00:00:00Z");
    },
    deleteMessage(stream, sequence, options = {}) {
      checked(options, ["no_erase"]);
      return this.management("message.delete", stream, "", {
        seq: revision(sequence),
        ...options,
      });
    },
    async storedMessage(stream, options) {
      const r = await this.management("message.get", stream, "", options);
      const m = r.message;
      if (!m || typeof m.subject !== "string" || !/^\d+$/.test(String(m.seq)))
        throw new Error("Invalid stored message");
      const decode = (x) => {
        if (x === undefined) return Buffer.alloc(0);
        if (
          typeof x !== "string" ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            x,
          )
        )
          throw new Error("Invalid stored Base64");
        const b = Buffer.from(x, "base64");
        if (b.toString("base64") !== x)
          throw new Error("Noncanonical stored Base64");
        return b;
      };
      const rawHeaders = decode(m.hdrs);
      const headers = command({
        action: "stored_headers",
        source: jsonText(rawHeaders),
      });
      return {
        subject: m.subject,
        sequence: String(m.seq),
        data: decode(m.data),
        rawHeaders,
        headers,
        time: m.time,
      };
    },
    async pushSubscribe(stream, consumer = "", options = {}) {
      const allowed = [
        "config",
        "queue",
        "maxMessages",
        "maxBytes",
        "signal",
        "bind",
      ];
      checked(options, allowed);
      if (options.bind !== undefined && typeof options.bind !== "boolean")
        throw new Error("Invalid Push bind policy");
      if (options.config !== undefined)
        command({
          action: "configuration",
          kind: "consumer",
          value: options.config,
        });
      if (options.signal?.aborted) throw new Error("Push subscription aborted");
      let config, info;
      if (options.bind) {
        info = await this.consumerInfo(stream, consumer);
        config = info.config;
      } else {
        config = {
          ack_policy: "explicit",
          deliver_policy: "all",
          ...options.config,
        };
        config.deliver_subject ??= "_INBOX." + name();
        if (consumer) {
          config.name ??= consumer;
          config.durable_name ??= consumer;
        }
      }
      if (typeof config.deliver_subject !== "string" || !config.deliver_subject)
        throw new Error("Not a Push consumer");
      const queue = options.queue ?? config.deliver_group ?? "";
      if (queue !== (config.deliver_group ?? ""))
        throw new Error("Push queue group mismatch");
      if (!["explicit", "all", "none"].includes(config.ack_policy))
        throw new Error("Invalid Push ACK policy");
      const heartbeatMs = Math.ceil(Number(config.idle_heartbeat ?? 0) / 1e6);
      const sub = this.subscribe(config.deliver_subject, {
        queue,
        maxMessages: options.maxMessages,
        maxBytes: options.maxBytes,
        signal: options.signal,
        heartbeatMs,
      });
      try {
        await sub.ready;
        if (!info) info = await this.createConsumerConfig(stream, config);
        let closed = false;
        return {
          stream,
          consumer: info.name,
          info,
          subscription: sub,
          [Symbol.asyncIterator]() {
            return this;
          },
          async next() {
            const r = await sub.next();
            if (r.done) return r;
            const m = new Message(sub.client, r.value, config.ack_policy);
            if (
              m.metadata &&
              (m.metadata.stream !== stream ||
                m.metadata.consumer !== info.name)
            ) {
              sub.fail(new Error("Push delivery identity mismatch"));
              throw sub.failure;
            }
            sub.client.count("deliveries");
            if (m.metadata && m.metadata.delivered !== "1")
              sub.client.count("redeliveries");
            return { value: m, done: false };
          },
          async return() {
            this.close();
            return { done: true };
          },
          close() {
            if (!closed) {
              closed = true;
              sub.close();
            }
          },
          async drain() {
            await sub.drain();
            closed = true;
          },
        };
      } catch (error) {
        sub.close();
        throw error;
      }
    },
  });
}
