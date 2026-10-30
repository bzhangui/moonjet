import {
  unique,
  options,
  integer,
  revision,
  latest,
  snapshot,
  watch,
} from "./storage-common.mjs";
export function installKV(Client, command) {
  const subject = (bucket, key, all = false) =>
    command({ action: "kv_subject", bucket, key, watch: all });
  class KeyValue {
    constructor(client, bucket) {
      subject(bucket, "validate");
      this.client = client;
      this.bucket = bucket;
      this.stream = "KV_" + bucket;
    }
    entry(m) {
      const prefix = "$KV." + this.bucket + ".";
      if (!m.subject.startsWith(prefix))
        throw new Error("KV subject identity mismatch");
      const key = m.subject.slice(prefix.length);
      subject(this.bucket, key);
      const op =
        m.headers?.filter((h) => h.name.toLowerCase() === "kv-operation") ?? [];
      if (op.length > 1 || op.some((h) => !["DEL", "PURGE"].includes(h.value)))
        throw new Error("Invalid KV operation");
      return {
        bucket: this.bucket,
        key,
        value: Buffer.from(m.data),
        revision: String(m.sequence ?? m.metadata.stream_sequence),
        operation: op[0]?.value ?? "PUT",
        time: m.time ?? m.metadata.timestamp,
      };
    }
    async get(key, opts = {}) {
      options(opts, ["revision", "includeDeleted"]);
      const s = subject(this.bucket, key);
      let m;
      if (opts.revision !== undefined) {
        try {
          m = await this.client.storedMessage(this.stream, {
            seq: revision(opts.revision),
          });
        } catch (e) {
          if (/10037\b|no message found/.test(e.message)) return null;
          throw e;
        }
        if (m.subject !== s)
          throw new Error("KV revision belongs to another key");
      } else m = await latest(this.client, this.stream, s);
      if (!m) return null;
      const entry = this.entry(m);
      return entry.operation === "PUT" || opts.includeDeleted ? entry : null;
    }
    async put(key, value, opts = {}) {
      options(opts, ["previousRevision", "messageId"]);
      const ack = await this.client.publish(
        subject(this.bucket, key),
        Buffer.from(value),
        {
          messageId: opts.messageId ?? unique(),
          ...(opts.previousRevision === undefined
            ? {}
            : { expectedLastSubjectSequence: revision(opts.previousRevision) }),
        },
      );
      return ack.sequence;
    }
    async create(key, value, opts = {}) {
      options(opts, ["messageId"]);
      const current = await this.get(key, { includeDeleted: true });
      return this.put(key, value, {
        ...opts,
        previousRevision:
          current && current.operation !== "PUT" ? current.revision : "0",
      });
    }
    update(key, value, previousRevision, opts = {}) {
      if (revision(previousRevision) === "0")
        throw new Error("Update needs a positive revision");
      return this.put(key, value, { ...opts, previousRevision });
    }
    async remove(key, purge, opts) {
      options(opts, ["previousRevision", "messageId"]);
      const ack = await this.client.publish(
        subject(this.bucket, key),
        Buffer.alloc(0),
        {
          messageId: opts.messageId ?? unique(),
          headers: [
            { name: "KV-Operation", value: purge ? "PURGE" : "DEL" },
            ...(purge ? [{ name: "Nats-Rollup", value: "sub" }] : []),
          ],
          ...(opts.previousRevision === undefined
            ? {}
            : { expectedLastSubjectSequence: revision(opts.previousRevision) }),
        },
      );
      return ack.sequence;
    }
    delete(key, opts = {}) {
      return this.remove(key, false, opts);
    }
    purge(key, opts = {}) {
      return this.remove(key, true, opts);
    }
    async *history(key, opts = {}) {
      options(opts, ["maxEntries", "signal"]);
      for await (const m of snapshot(
        this.client,
        this.stream,
        subject(this.bucket, key),
        opts,
      ))
        yield this.entry(m);
    }
    async *keys(filter = ">", opts = {}) {
      options(opts, ["maxEntries", "signal"]);
      for await (const m of snapshot(
        this.client,
        this.stream,
        subject(this.bucket, filter, true),
        { ...opts, last: true },
      )) {
        const e = this.entry(m);
        if (e.operation === "PUT") yield e.key;
      }
    }
    watch(filter = ">", opts = {}) {
      options(opts, [
        "history",
        "includeInitial",
        "maxMessages",
        "maxBytes",
        "signal",
      ]);
      return watch(
        this.client,
        this.stream,
        subject(this.bucket, filter, true),
        (m) => this.entry(m),
        opts,
      );
    }
    status() {
      return this.client.streamInfo(this.stream);
    }
    async updateConfig(changes) {
      options(changes, [
        "description",
        "history",
        "ttlMs",
        "maxBytes",
        "replicas",
        "metadata",
      ]);
      const old = (await this.status()).config;
      const config = { ...old };
      if (changes.history !== undefined)
        config.max_msgs_per_subject = integer(
          changes.history,
          1,
          64,
          "KV history",
        );
      if (changes.ttlMs !== undefined)
        config.max_age = String(
          BigInt(integer(changes.ttlMs, 0, 2147483647, "KV TTL")) * 1000000n,
        );
      for (const [a, b] of [
        ["description", "description"],
        ["maxBytes", "max_bytes"],
        ["replicas", "num_replicas"],
        ["metadata", "metadata"],
      ])
        if (changes[a] !== undefined) config[b] = changes[a];
      return this.client.updateStream(config);
    }
    destroy() {
      return this.client.deleteStream(this.stream);
    }
  }
  Client.prototype.createKeyValue = async function (bucket, opts = {}) {
    options(opts, [
      "history",
      "ttlMs",
      "storage",
      "replicas",
      "maxBytes",
      "description",
      "metadata",
      "placement",
      "mirror",
      "sources",
    ]);
    const config = command({
      action: "kv_config",
      bucket,
      history: opts.history ?? 1,
      ttl_ms: opts.ttlMs ?? 0,
    });
    config.max_bytes = integer(
      opts.maxBytes ?? 67108864,
      1,
      1073741824,
      "KV bytes",
    );
    config.num_replicas = integer(opts.replicas ?? 1, 1, 5, "replicas");
    for (const k of [
      "storage",
      "description",
      "metadata",
      "placement",
      "mirror",
      "sources",
    ])
      if (opts[k] !== undefined) config[k] = opts[k];
    if (config.mirror || config.sources)
      throw new Error(
        "Use the management API for mirror/source provisioning; specialized KV origin routing is not enabled",
      );
    await this.createStreamConfig(config);
    return new KeyValue(this, bucket);
  };
  Client.prototype.keyValue = async function (bucket) {
    const kv = new KeyValue(this, bucket);
    const info = await kv.status();
    if (
      !info.config.subjects?.includes(subject(bucket, ">", true)) &&
      !info.config.mirror
    )
      throw new Error("Not a KV bucket");
    if (info.config.mirror || info.config.sources)
      throw new Error(
        "Mirrored/sourced KV requires an explicit origin handle; use management API",
      );
    return kv;
  };
}
