// Tamper/corruption detection. Each event carries a checksum over its own
// content and a hash linking to the previous event. Walking the chain localizes
// the exact seq where the log was truncated or a byte flipped, which is what
// crash recovery needs to trim a partial trailing write.

import { createHash } from "node:crypto";

export const GENESIS_HASH = "0".repeat(64);

export function sha256(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// Deterministic JSON: object keys sorted recursively so the checksum does not
// depend on insertion order. Arrays keep their order (it is semantic).
export function canonicalize(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
  return out;
}

export function eventChecksum(seq, type, ts, payload) {
  return sha256(`${seq} ${type} ${ts} ${canonicalize(payload)}`);
}

export function eventHash(checksum, prevHash) {
  return sha256(`${checksum} ${prevHash}`);
}
