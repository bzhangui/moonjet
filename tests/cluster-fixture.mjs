import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { serverBinary } from "../examples/server.mjs";
export async function startCluster() {
  const parent = fs.realpathSync(os.tmpdir()),
    base = fs.mkdtempSync(path.join(parent, "moonjet-cluster-"));
  const cluster = "MJ_" + randomUUID().replaceAll("-", "");
  const members = [];
  const ports = [],
    reservations = [];
  for (let i = 0; i < 3; i++) {
    const reservation = net.createServer();
    await new Promise((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolve);
    });
    ports.push(reservation.address().port);
    reservations.push(reservation);
  }
  for (const reservation of reservations)
    await new Promise((resolve) => reservation.close(resolve));
  for (let i = 0; i < 3; i++) members.push({ index: i, route: ports[i] });
  async function stop(m, hard = false) {
    if (
      !m.process ||
      m.process.exitCode !== null ||
      m.process.signalCode !== null
    )
      return;
    const end = once(m.process, "exit");
    m.process.kill(hard ? "SIGKILL" : "SIGTERM");
    await end;
  }
  async function start(m) {
    const routes = members
      .filter((x) => x !== m && x.route)
      .map((x) => "nats://127.0.0.1:" + x.route);
    const config = {
      server_name: cluster + "_" + m.index,
      host: "127.0.0.1",
      port: m.port ?? -1,
      jetstream: {
        store_dir: path.join(base, "store-" + m.index),
        max_mem: 33554432,
        max_file: 134217728,
      },
      cluster: {
        name: cluster,
        host: "127.0.0.1",
        port: m.route ?? -1,
        routes,
      },
    };
    const file = path.join(base, "node-" + m.index + ".conf");
    fs.writeFileSync(file, JSON.stringify(config));
    m.process = spawn(serverBinary(), ["-c", file], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    await new Promise((resolve, reject) => {
      let text = "",
        done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          reject(new Error("Owned cluster startup deadline"));
        }
      }, 15000);
      const fail = () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          reject(
            new Error(
              "Owned cluster start failed: " +
                text.slice(-1400).replaceAll(base, "<owned-fixture>"),
            ),
          );
        }
      };
      m.process.once("error", fail);
      m.process.once("exit", fail);
      m.process.stderr.on("data", (b) => {
        text = (text + b.toString()).slice(-16384);
        const client =
          /Listening for client connections on 127\.0\.0\.1:(\d+)/.exec(text);
        const route =
          /Listening for route connections on 127\.0\.0\.1:(\d+)/.exec(text);
        if (client && route && !done) {
          m.port = Number(client[1]);
          m.route = Number(route[1]);
          done = true;
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }
  async function cleanup() {
    for (const m of members) await stop(m);
    if (
      path.dirname(base) !== parent ||
      !path.basename(base).startsWith("moonjet-cluster-")
    )
      throw new Error("Unsafe cluster cleanup");
    fs.rmSync(base, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 50,
    });
  }
  try {
    for (const m of members) await start(m);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return {
    members,
    get urls() {
      return members.map((m) => "nats://127.0.0.1:" + m.port);
    },
    stop: async (i, hard = true) => stop(members[i], hard),
    restart: async (i) => start(members[i]),
    cleanup,
  };
}
