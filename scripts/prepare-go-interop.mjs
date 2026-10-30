import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const local = path.join(
  root,
  ".local/tools/go/bin",
  process.platform === "win32" ? "go.exe" : "go",
);
const go = process.env.GO_BIN || (fs.existsSync(local) ? local : "go");
const env = {
  ...process.env,
  GOTELEMETRY: "off",
  GOMODCACHE: path.join(root, ".local/go-mod"),
  GOCACHE: path.join(root, ".local/go-cache"),
};
fs.mkdirSync(path.join(root, ".local/tools"), { recursive: true });
for (const args of [
  ["mod", "verify"],
  [
    "build",
    "-mod=readonly",
    "-trimpath",
    "-o",
    path.join(
      root,
      ".local/tools",
      process.platform === "win32" ? "interop-go.exe" : "interop-go",
    ),
    ".",
  ],
]) {
  const r = spawnSync(go, args, {
    cwd: path.join(root, "tests/interop-go"),
    env,
    stdio: "inherit",
    windowsHide: true,
    timeout: 180000,
  });
  if (r.status !== 0 || r.error)
    throw new Error("Official Go interoperability fixture build failed");
}
console.log(
  "Built pinned nats.go/jwt interoperability fixture; not a runtime dependency.",
);
