import { createHash } from "node:crypto";
import {
  unique,
  options,
  integer,
  revision,
  latest,
  snapshot,
  watch,
  text,
} from "./storage-common.mjs";
const padded = (b) =>
  Buffer.from(b).toString("base64").replaceAll("+", "-").replaceAll("/", "_");
const digest = (b) => "SHA-256=" + padded(b);
export function installObjectStore(Client, command) {
  function identity(bucket, name) {
    command({ action: "kv_subject", bucket, key: "validate" });
    if (
      typeof name !== "string" ||
      !name.length ||
      Buffer.byteLength(name) > 512 ||
      /[\x00-\x1f\x7f]/.test(name)
    )
      throw new Error("Invalid object name");
    return "$O." + bucket + ".M." + padded(Buffer.from(name));
  }
  class ObjectStore {
    constructor(client, bucket) {
      identity(bucket, "validate");
      this.client = client;
      this.bucket = bucket;
      this.stream = "OBJ_" + bucket;
    }
    decode(m) {
      const info = command({ action: "response", source: text(m.data) });
      command({
        action: "object_info",
        info,
        bucket: this.bucket,
        name: info.name,
      });
      if (m.subject !== identity(this.bucket, info.name))
        throw new Error("Object metadata subject mismatch");
      if (info.nuid !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(info.nuid))
        throw new Error("Invalid object chunk identifier");
      return {
        ...info,
        revision: String(m.sequence ?? m.metadata.stream_sequence),
      };
    }
    async info(name, opts = {}) {
      options(opts, ["includeDeleted"]);
      const { includeDeleted = false } = opts;
      if (typeof includeDeleted !== "boolean")
        throw new Error("Invalid includeDeleted");
      const m = await latest(
        this.client,
        this.stream,
        identity(this.bucket, name),
      );
      if (!m) return null;
      const info = this.decode(m);
      return info.deleted && !includeDeleted ? null : info;
    }
    async metadata(info, previousRevision) {
      const { revision: ignored, ...wire } = info;
      command({
        action: "object_info",
        info: wire,
        bucket: this.bucket,
        name: wire.name,
      });
      const ack = await this.client.publish(
        identity(this.bucket, wire.name),
        Buffer.from(JSON.stringify(wire)),
        {
          messageId: unique(),
          expectedLastSubjectSequence: revision(previousRevision),
          headers: [{ name: "Nats-Rollup", value: "sub" }],
        },
      );
      return { ...wire, revision: ack.sequence };
    }
    async put(name, input, opts = {}) {
      options(opts, [
        "description",
        "metadata",
        "headers",
        "chunkSize",
        "maxBytes",
        "previousRevision",
        "signal",
      ]);
      identity(this.bucket, name);
      const maxBytes = integer(
        opts.maxBytes ?? 67108864,
        0,
        1073741824,
        "object bytes",
      );
      const chunkSize = integer(
        opts.chunkSize ?? 131072,
        1,
        Math.min(this.client.maxPayload - 4096, 524288),
        "chunk bytes",
      );
      const prior = await this.info(name, { includeDeleted: true });
      const expected =
        opts.previousRevision === undefined
          ? (prior?.revision ?? "0")
          : revision(opts.previousRevision);
      const nuid = unique(),
        subject = "$O." + this.bucket + ".C." + nuid,
        sha = createHash("sha256");
      let size = 0,
        chunks = 0,
        metadataStarted = false;
      const source =
        Buffer.isBuffer(input) || input instanceof Uint8Array ? [input] : input;
      if (
        !source ||
        (!source[Symbol.asyncIterator] && !source[Symbol.iterator])
      )
        throw new Error("Object input must be bytes or iterable bytes");
      let carry = Buffer.alloc(0);
      const publish = async (b) => {
        if (opts.signal?.aborted) throw new Error("Object upload aborted");
        sha.update(b);
        await this.client.publish(subject, b, {
          messageId: nuid + "-" + chunks,
        });
        chunks++;
      };
      try {
        for await (const piece of source) {
          if (!(piece instanceof Uint8Array))
            throw new Error("Object chunks must be byte arrays");
          // Check the bound before copying caller-controlled chunks.
          if (size + piece.byteLength > maxBytes)
            throw new Error("Object byte budget exceeded");
          size += piece.byteLength;
          let bytes = Buffer.from(
            piece.buffer,
            piece.byteOffset,
            piece.byteLength,
          );
          if (carry.length) {
            const needed = chunkSize - carry.length;
            if (bytes.length < needed) {
              carry = Buffer.concat([carry, bytes]);
              continue;
            }
            await publish(Buffer.concat([carry, bytes.subarray(0, needed)]));
            bytes = bytes.subarray(needed);
            carry = Buffer.alloc(0);
          }
          while (bytes.length >= chunkSize) {
            await publish(bytes.subarray(0, chunkSize));
            bytes = bytes.subarray(chunkSize);
          }
          carry = Buffer.from(bytes);
        }
        if (carry.length) await publish(carry);
        if (opts.signal?.aborted) throw new Error("Object upload aborted");
        const info = {
          name,
          bucket: this.bucket,
          nuid,
          size,
          chunks,
          digest: digest(sha.digest()),
          mtime: new Date().toISOString(),
          deleted: false,
          options: { max_chunk_size: chunkSize },
        };
        for (const k of ["description", "metadata", "headers"])
          if (opts[k] !== undefined) info[k] = opts[k];
        metadataStarted = true;
        const result = await this.metadata(info, expected);
        // Old chunks are retained intentionally: concurrent readers may still be
        // using the previous metadata. Explicit audit/GC is a separate operation.
        return result;
      } catch (error) {
        // A metadata timeout is ambiguous: never erase possibly committed data.
        if (!metadataStarted && this.client.status === "connected") {
          try {
            await this.client.purgeStream(this.stream, { filter: subject });
          } catch {}
        }
        throw error;
      }
    }
    async get(name, opts = {}) {
      options(opts, ["maxBytes", "maxChunks", "signal", "_visited"]);
      const visited = new Set(opts._visited ?? []),
        id = this.bucket + "\0" + name;
      if (visited.has(id) || visited.size >= 16)
        throw new Error("Object link cycle or depth budget");
      visited.add(id);
      const info = await this.info(name);
      if (!info) return null;
      const link = info.options?.link;
      if (link) {
        if (typeof link.name !== "string" || !link.name)
          throw new Error("Bucket link: open the linked bucket explicitly");
        return (await this.client.objectStore(link.bucket)).get(link.name, {
          ...opts,
          _visited: visited,
        });
      }
      const maxBytes = integer(
        opts.maxBytes ?? 67108864,
        0,
        1073741824,
        "object bytes",
      );
      const maxChunks = integer(
        opts.maxChunks ?? 100000,
        1,
        100000,
        "object chunks",
      );
      if (
        !Number.isSafeInteger(info.size) ||
        info.size < 0 ||
        info.size > maxBytes ||
        !Number.isSafeInteger(info.chunks) ||
        info.chunks < 0 ||
        info.chunks > maxChunks ||
        !info.nuid
      )
        throw new Error("Object transfer budget exceeded");
      const client = this.client,
        stream = this.stream,
        filter = "$O." + this.bucket + ".C." + info.nuid;
      const data = (async function* () {
        let size = 0,
          chunks = 0;
        const sha = createHash("sha256");
        if (info.chunks)
          for await (const m of snapshot(client, stream, filter, {
            maxEntries: maxChunks,
            signal: opts.signal,
          })) {
            if (m.subject !== filter)
              throw new Error("Object chunk subject mismatch");
            size += m.data.length;
            chunks++;
            if (size > info.size || size > maxBytes || chunks > info.chunks)
              throw new Error("Object transfer exceeds manifest");
            sha.update(m.data);
            yield Buffer.from(m.data);
          }
        if (
          size !== info.size ||
          chunks !== info.chunks ||
          digest(sha.digest()) !== info.digest
        )
          throw new Error("Object integrity mismatch: size/chunks/SHA-256");
      })();
      return { info, data };
    }
    async getBytes(name, opts = {}) {
      const r = await this.get(name, opts);
      if (!r) return null;
      const parts = [];
      for await (const b of r.data) parts.push(b);
      return Buffer.concat(parts);
    }
    async delete(name) {
      const old = await this.info(name);
      if (!old) return { success: false };
      await this.metadata(
        { ...old, deleted: true, size: 0, chunks: 0, digest: "" },
        old.revision,
      );
      return { success: true };
    }
    async updateMetadata(name, changes) {
      options(changes, ["description", "metadata", "headers"]);
      const old = await this.info(name);
      if (!old) throw new Error("Object not found");
      return this.metadata({ ...old, ...changes }, old.revision);
    }
    async link(name, bucket, targetName) {
      identity(this.bucket, name);
      identity(bucket, targetName ?? "bucket");
      if (targetName !== undefined) {
        const target = await (
          await this.client.objectStore(bucket)
        ).info(targetName);
        if (!target) throw new Error("Link target not found");
        if (target.options?.link)
          throw new Error("Cannot link to another link");
      }
      const old = await this.info(name, { includeDeleted: true });
      return this.metadata(
        {
          name,
          bucket: this.bucket,
          nuid: unique(),
          size: 0,
          chunks: 0,
          digest: "",
          mtime: new Date().toISOString(),
          deleted: false,
          options: {
            link: {
              bucket,
              ...(targetName === undefined ? {} : { name: targetName }),
            },
          },
        },
        old?.revision ?? "0",
      );
    }
    async *list(opts = {}) {
      options(opts, ["maxEntries", "signal", "includeDeleted"]);
      const { includeDeleted, ...limits } = opts;
      for await (const m of snapshot(
        this.client,
        this.stream,
        "$O." + this.bucket + ".M.>",
        { ...limits, last: true },
      )) {
        const info = this.decode(m);
        if (!info.deleted || includeDeleted) yield info;
      }
    }
    watch(opts = {}) {
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
        "$O." + this.bucket + ".M.>",
        (m) => this.decode(m),
        opts,
      );
    }
    status() {
      return this.client.streamInfo(this.stream);
    }
    async garbageCollect(opts = {}) {
      options(opts, ["dryRun", "confirmQuiescent", "maxEntries", "signal"]);
      if (opts.dryRun !== undefined && typeof opts.dryRun !== "boolean")
        throw new Error("Invalid GC dryRun");
      const dryRun = opts.dryRun ?? true;
      if (!dryRun && opts.confirmQuiescent !== true)
        throw new Error(
          "Stop all bucket writers/readers and confirmQuiescent before reclamation",
        );
      const limits = {
        maxEntries: opts.maxEntries ?? 100000,
        signal: opts.signal,
      };
      const references = new Set();
      for await (const info of this.list(limits))
        if (!info.options?.link) references.add(info.nuid);
      const candidates = new Set(),
        prefix = "$O." + this.bucket + ".C.";
      for await (const m of snapshot(
        this.client,
        this.stream,
        prefix + ">",
        limits,
      )) {
        const id = m.subject.slice(prefix.length);
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id))
          throw new Error("Unsafe GC chunk identity");
        if (!references.has(id)) candidates.add(id);
      }
      // Recheck the metadata high-water mark after enumeration. This detects
      // observed changes, not a distributed lock; quiescence remains mandatory.
      const current = new Set();
      for await (const info of this.list(limits))
        if (!info.options?.link) current.add(info.nuid);
      if (
        current.size !== references.size ||
        [...current].some((n) => !references.has(n))
      )
        throw new Error("Object metadata changed during GC");
      let purged = 0;
      if (!dryRun)
        for (const id of candidates) {
          if (opts.signal?.aborted) throw new Error("Object GC aborted");
          const r = await this.client.purgeStream(this.stream, {
            filter: prefix + id,
          });
          purged += Number(r.purged);
        }
      return {
        dryRun,
        orphanGenerations: candidates.size,
        purged,
        requiresQuiescence: true,
      };
    }
    async seal() {
      const info = await this.status();
      return this.client.updateStream({ ...info.config, sealed: true });
    }
    destroy() {
      return this.client.deleteStream(this.stream);
    }
  }
  Client.prototype.createObjectStore = async function (bucket, opts = {}) {
    options(opts, [
      "storage",
      "replicas",
      "maxBytes",
      "ttlMs",
      "description",
      "metadata",
      "placement",
      "compression",
    ]);
    identity(bucket, "validate");
    const config = {
      name: "OBJ_" + bucket,
      subjects: ["$O." + bucket + ".C.>", "$O." + bucket + ".M.>"],
      storage: opts.storage ?? "file",
      num_replicas: integer(opts.replicas ?? 1, 1, 5, "replicas"),
      max_bytes: integer(
        opts.maxBytes ?? 268435456,
        1,
        1073741824,
        "store bytes",
      ),
      max_age: String(
        BigInt(integer(opts.ttlMs ?? 0, 0, 2147483647, "TTL")) * 1000000n,
      ),
      allow_rollup_hdrs: true,
      allow_direct: true,
      discard: "new",
    };
    for (const k of ["description", "metadata", "placement", "compression"])
      if (opts[k] !== undefined) config[k] = opts[k];
    await this.createStreamConfig(config);
    return new ObjectStore(this, bucket);
  };
  Client.prototype.objectStore = async function (bucket) {
    const store = new ObjectStore(this, bucket);
    const info = await store.status();
    if (
      !info.config.subjects?.includes("$O." + bucket + ".M.>") ||
      !info.config.subjects?.includes("$O." + bucket + ".C.>")
    )
      throw new Error("Not an Object Store");
    return store;
  };
}
