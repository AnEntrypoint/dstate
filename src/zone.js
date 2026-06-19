// Zone math (pure). A zone is a named subgraph the agent may move within under
// its `intra` policy; leaving or entering one is a boundary crossing under the
// stricter `boundary` policy. Nesting/overlap is resolved by taking the
// strictest applicable mode, which is deterministic and easy to explain.

const RANK = { off: 0, soft: 1, hard: 2 };

export function strictest(modes, fallback = "off") {
  let best = fallback;
  for (const m of modes) if (RANK[m] > RANK[best]) best = m;
  return best;
}

export function crossingInfo(srcZones, dstZones) {
  const srcSet = new Set(srcZones);
  const dstSet = new Set(dstZones);
  const left = srcZones.filter((z) => !dstSet.has(z));
  const entered = dstZones.filter((z) => !srcSet.has(z));
  const shared = srcZones.filter((z) => dstSet.has(z));
  return { crossing: left.length > 0 || entered.length > 0, left, entered, shared };
}

/** Strictest boundary mode among the zones being left or entered. */
export function boundaryMode(zones, names) {
  return strictest(names.map((n) => zones.get(n)?.boundary ?? "off"));
}

/** Strictest intra mode among shared zones (innermost-strictest by max rank). */
export function intraMode(zones, shared) {
  return strictest(shared.map((n) => zones.get(n)?.intra ?? "off"));
}
