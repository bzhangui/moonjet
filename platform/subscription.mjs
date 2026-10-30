export class Subscription {
  constructor(
    client,
    subject,
    sid,
    {
      queue = "",
      maxMessages = 256,
      maxBytes = 8388608,
      heartbeatMs = 0,
      signal,
    } = {},
  ) {
    for (const [n, x, min, max] of [
      ["maxMessages", maxMessages, 1, 4096],
      ["maxBytes", maxBytes, 1, 67108864],
      ["heartbeatMs", heartbeatMs, 0, 300000],
    ])
      if (!Number.isSafeInteger(x) || x < min || x > max)
        throw new Error("Invalid subscription " + n);
    this.client = client;
    this.subject = subject;
    this.sid = sid;
    this.queue = queue;
    this.limit = maxMessages;
    this.byteLimit = maxBytes;
    this.items = [];
    this.bytes = 0;
    this.waiter = null;
    this.closed = false;
    this.failure = null;
    this.lastSeen = performance.now();
    this.abort = () => this.close();
    this.signal = signal;
    if (signal) {
      if (typeof signal.addEventListener !== "function")
        throw new Error("Invalid subscription signal");
      signal.addEventListener("abort", this.abort, { once: true });
    }
    if (heartbeatMs)
      this.monitor = setInterval(
        () => {
          if (
            client.status === "connected" &&
            performance.now() - this.lastSeen > heartbeatMs * 3
          )
            this.fail(new Error("Push heartbeat expired"));
        },
        Math.max(50, heartbeatMs),
      );
  }
  reconnected() {
    this.lastSeen = performance.now();
    this.items = [];
    this.bytes = 0;
  }
  disconnected() {
    this.items = [];
    this.bytes = 0;
  }
  receive(frame) {
    if (this.closed) return;
    this.lastSeen = performance.now();
    if (frame.status === 100) {
      const reply =
        frame.reply ||
        frame.headers?.find(
          (h) => h.name.toLowerCase() === "nats-consumer-stalled",
        )?.value;
      if (reply) {
        if (!reply.startsWith("$JS.FC."))
          return this.fail(new Error("Unsafe flow control subject"));
        try {
          this.client.raw({ action: "pub", subject: reply }, Buffer.alloc(0));
        } catch (e) {
          this.fail(e);
        }
      }
      return;
    }
    if (frame.status)
      return this.fail(new Error("Subscription status " + frame.status));
    const bytes = frame.data.length / 2;
    if (
      bytes > this.byteLimit ||
      this.items.length >= this.limit ||
      this.bytes + bytes > this.byteLimit
    )
      return this.fail(new Error("Slow consumer subscription budget exceeded"));
    const message = {
      ...frame,
      generation: this.client.generation,
      data: Buffer.from(frame.data, "hex"),
    };
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve({ value: message, done: false });
    } else {
      this.items.push(message);
      this.bytes += bytes;
    }
  }
  next() {
    if (this.items.length) {
      const value = this.items.shift();
      this.bytes -= value.data.length;
      return Promise.resolve({ value, done: false });
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.resolve({ done: true });
    if (this.waiter)
      return Promise.reject(
        new Error("Only one subscription iterator may await next"),
      );
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
  [Symbol.asyncIterator]() {
    return this;
  }
  async return() {
    this.close();
    return { done: true };
  }
  fail(error) {
    this.failure = error;
    this.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.monitor);
    this.signal?.removeEventListener("abort", this.abort);
    this.client.subscriptions.delete(this.sid);
    this.items = [];
    this.bytes = 0;
    if (this.client.status === "connected") {
      try {
        this.client.raw({ action: "unsub", sid: this.sid });
      } catch {
        this.client.socket?.destroy();
      }
    }
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      if (this.failure) w.reject(this.failure);
      else w.resolve({ done: true });
    }
  }
  async drain() {
    if (this.closed) return;
    // Remove server interest first, then retain all already received deliveries.
    this.client.raw({ action: "unsub", sid: this.sid });
    await this.client.flush();
    const buffered = this.items;
    const bytes = this.bytes;
    this.items = [];
    this.close();
    this.items = buffered;
    this.bytes = bytes;
  }
}
