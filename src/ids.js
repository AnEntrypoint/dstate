// Monotonic, lexically-sortable ids (ULID-shaped: 48-bit time + 32-bit counter
// + entropy, Crockford base32). Sorting by id reproduces creation order, which
// matters because event seq and node/edge ids must agree on ordering for the
// projection to be deterministic. A monotonic counter guards against same-ms
// collisions instead of trusting wall-clock resolution.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(value, length) {
  let out = "";
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out = CROCKFORD[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return out;
}

export class IdGen {
  constructor(opts = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.rand = opts.rand ?? Math.random;
    this.lastTime = -1;
    this.counter = 0;
  }

  /** Generate a sortable id with an optional 1-char type prefix. */
  next(prefix = "") {
    let t = this.now();
    if (t <= this.lastTime) {
      // clock did not advance (or went backwards): keep ordering monotone
      this.counter += 1;
      t = this.lastTime;
    } else {
      this.lastTime = t;
      this.counter = 0;
    }
    const timePart = encodeBase32(t % 281474976710656, 10); // 48 bits
    const counterPart = encodeBase32(this.counter % 1048576, 4); // 20 bits
    const entropy = encodeBase32(Math.floor(this.rand() * 1073741824), 6); // 30 bits
    return prefix + timePart + counterPart + entropy;
  }
}

/** Validate an agent-supplied id: keeps SQL/FTS and rendering safe. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export function isValidId(id) {
  return ID_RE.test(id);
}
