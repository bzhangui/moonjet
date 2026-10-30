// Ed25519 uses the system crypto provider. MoonBit validates the NKey envelope.
import fs from "node:fs";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
const text = (x, label) => {
  if (
    typeof x !== "string" ||
    !x ||
    Buffer.byteLength(x) > 65536 ||
    /[\0\r\n]/.test(x)
  )
    throw new Error("Invalid " + label);
  return x;
};
async function value(x) {
  return typeof x === "function" ? await x() : x;
}
export function nkeyAuthenticator(seed, jwt) {
  return async ({ nonce, core }) => {
    const source = await value(seed),
      claim = jwt === undefined ? undefined : await value(jwt);
    text(source, "NKey seed");
    text(nonce, "server nonce");
    if (claim !== undefined) text(claim, "user JWT");
    let secret;
    try {
      secret = Buffer.from(core({ action: "nkey_seed", seed: source }), "hex");
      const der = Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        secret,
      ]);
      let key;
      try {
        key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
      } finally {
        der.fill(0);
      }
      const publicBytes = createPublicKey(key)
        .export({ format: "der", type: "spki" })
        .subarray(-32);
      const nkey = core({ action: "nkey_public", bytes: [...publicBytes] });
      const sig = sign(null, Buffer.from(nonce), key).toString("base64url");
      return claim === undefined ? { nkey, sig } : { jwt: claim, sig };
    } catch {
      throw new Error("NKey/JWT credentials rejected");
    } finally {
      secret?.fill(0);
    }
  };
}
export function jwtAuthenticator(jwt, seed) {
  return nkeyAuthenticator(seed, jwt);
}
export function credentialsAuthenticator(source) {
  // A callback may supply bytes/text on each reconnect; a path is explicit here.
  return async (context) => {
    try {
      const input =
        typeof source === "function" ? await source() : fs.readFileSync(source);
      if (
        !(typeof input === "string" || Buffer.isBuffer(input)) ||
        Buffer.byteLength(input) > 65536
      )
        throw new Error();
      const content = String(input);
      const claim =
        /-----BEGIN NATS USER JWT-----\s*([A-Za-z0-9_.-]+)\s*------?END NATS USER JWT------?/.exec(
          content,
        );
      const seed =
        /-----BEGIN USER NKEY SEED-----\s*([A-Z2-7]+)\s*------?END USER NKEY SEED------?/.exec(
          content,
        );
      if (!claim || !seed) throw new Error();
      return await jwtAuthenticator(claim[1], seed[1])(context);
    } catch {
      throw new Error("Credentials unavailable or malformed");
    }
  };
}
