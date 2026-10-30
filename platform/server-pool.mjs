export class ServerPool {
  constructor(
    urls,
    { discoveryAllowlist = [], allowServerDiscovery = true } = {},
  ) {
    if (!Array.isArray(urls) || !urls.length || urls.length > 32)
      throw new Error("Server pool must contain 1..32 seeds");
    if (
      !Array.isArray(discoveryAllowlist) ||
      discoveryAllowlist.length > 64 ||
      discoveryAllowlist.some(
        (x) => typeof x !== "string" || !x || /[\s/@?#]/.test(x),
      )
    )
      throw new Error("Invalid discovery allowlist");
    if (typeof allowServerDiscovery !== "boolean")
      throw new Error("Invalid discovery policy");
    this.urls = [];
    this.cursor = 0;
    this.allow = allowServerDiscovery;
    for (const url of urls) this.add(url, true);
    this.scheme = new URL(this.urls[0]).protocol;
    if (this.urls.some((x) => new URL(x).protocol !== this.scheme))
      throw new Error("Mixed TLS/plaintext seed pools are prohibited");
    this.trusted = new Set([
      ...this.urls.map((x) => new URL(x).hostname),
      ...discoveryAllowlist,
    ]);
  }
  add(value, seed = false) {
    if (typeof value !== "string" || value.length > 1024)
      throw new Error("Invalid server address");
    const u = new URL(value);
    if (
      !["nats:", "tls:"].includes(u.protocol) ||
      !u.hostname ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !["", "/"].includes(u.pathname)
    )
      throw new Error("Unsafe server endpoint");
    const port = Number(u.port || 4222);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid server port");
    const normalized = u.protocol + "//" + u.hostname + ":" + port;
    if (
      !seed &&
      (!this.allow ||
        u.protocol !== this.scheme ||
        !this.trusted.has(u.hostname))
    )
      return false;
    if (this.urls.includes(normalized)) return false;
    if (this.urls.length >= 32) {
      if (seed) throw new Error("Server pool budget");
      return false;
    }
    this.urls.push(normalized);
    return true;
  }
  discover(addresses) {
    if (!this.allow || addresses === undefined) return;
    if (!Array.isArray(addresses) || addresses.length > 256)
      throw new Error("Invalid discovered server list");
    for (const address of addresses) {
      if (
        typeof address !== "string" ||
        address.length > 512 ||
        /[\s/@?#]/.test(address)
      )
        throw new Error("Unsafe discovered address");
      // INFO advertises host:port, never credentials, transport changes or paths.
      this.add(this.scheme + "//" + address);
    }
  }
  current() {
    return new URL(this.urls[this.cursor]);
  }
  advance(core) {
    this.cursor = core({
      action: "pool_index",
      attempt: this.cursor + 1,
      size: this.urls.length,
    });
    return this.current();
  }
}
