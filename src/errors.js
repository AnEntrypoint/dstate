// Typed error model. Every agent-facing verb returns Result<T, DStateError>
// rather than throwing on bad input: misuse is data, not a crash. Internal
// invariant breaches (which mean adaptogen itself is wrong) still throw.
//
// Error codes (the typed `code` field on every DStateError):
//   NotFound, DuplicateId, InvalidInput, PayloadTooLarge, CycleRejected,
//   IllegalTransition, HardBlocked, GuardParseError, IntegrityBroken,
//   LockHeld, Conflict, ZoneNotFound, CheckpointNotFound, MigrationError,
//   InvalidConfig, NoMoves

export const ERROR_CODES = [
  "NotFound",
  "DuplicateId",
  "InvalidInput",
  "PayloadTooLarge",
  "CycleRejected",
  "IllegalTransition",
  "HardBlocked",
  "GuardParseError",
  "IntegrityBroken",
  "LockHeld",
  "Conflict",
  "ZoneNotFound",
  "CheckpointNotFound",
  "MigrationError",
  "InvalidConfig",
  "NoMoves",
];

export class DStateError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "DStateError";
    this.code = code;
    this.details = details;
  }
  toJSON() {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

// Result type: explicit success/failure without exceptions on the happy/expected
// failure paths. `unwrap` is for tests and call sites that have already checked.
export const ok = (value) => ({ ok: true, value });
export const err = (error) => ({ ok: false, error });

export function isOk(r) {
  return r.ok;
}
export function isErr(r) {
  return !r.ok;
}

export function unwrap(r) {
  if (r.ok) return r.value;
  throw r.error;
}

export function fail(code, message, details) {
  return err(new DStateError(code, message, details));
}
