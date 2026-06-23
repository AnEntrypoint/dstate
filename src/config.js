// Tunables the agent reads and sets. Stored as ConfigSet events (cfg:* meta
// rows) so changes are durable and auditable. Each setter is range-checked: an
// out-of-range knob is a typed InvalidConfig error, never a silently-accepted
// bad value. Scope: FSM + persistence only -- there are no learning knobs.

import { ok, fail } from "./errors.js";

export const DEFAULT_TUNABLES = {
  defaultEnforcement: "soft",
  snapshotInterval: 200,
  retain: 1000,
  maxPayloadBytes: 256 * 1024,
};

const MODES = ["off", "soft", "hard"];

export function validateTunable(key, value) {
  switch (key) {
    case "defaultEnforcement":
      return MODES.includes(value)
        ? ok(value)
        : fail("InvalidConfig", `defaultEnforcement must be off|soft|hard`);
    case "snapshotInterval":
    case "retain":
      return isInt(value, 0) ? ok(value) : fail("InvalidConfig", `${key} must be a non-negative integer`);
    case "maxPayloadBytes":
      return isInt(value, 64) ? ok(value) : fail("InvalidConfig", "maxPayloadBytes >= 64");
    default:
      return fail("InvalidConfig", `unknown tunable '${String(key)}'`);
  }
}

function isInt(v, lo) {
  return typeof v === "number" && Number.isInteger(v) && v >= lo;
}
