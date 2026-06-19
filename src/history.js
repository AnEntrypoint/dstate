// History query over the event log. The log is the audit trail: transitions,
// blocks, soft violations, rewards, evolutions. reward() credit-assignment and
// the CLI both read through here. ASCII-only, human/agent readable.

export function history(ds, filter = {}) {
  const limit = filter.limit ?? 100;
  const opts = {
    ...(filter.fromSeq != null ? { fromSeq: filter.fromSeq } : {}),
    ...(filter.type ? { type: filter.type } : {}),
  };
  const toEntry = (e) => ({ seq: e.seq, ts: e.ts, type: e.type, summary: summarize(e.type, e.payload), payload: e.payload });
  // Fast path: no per-event node/edge filter -- push limit into the store query.
  if (!filter.node && !filter.edge) {
    return ds.store.readEvents({ ...opts, limit }).map(toEntry);
  }
  const matched = ds.store.readEvents(opts).filter((e) => {
    const p = e.payload;
    if (filter.node && p.to !== filter.node && p.from !== filter.node && p.id !== filter.node) return false;
    if (filter.edge && p.edgeId !== filter.edge && p.id !== filter.edge) return false;
    return true;
  });
  return matched.slice(-limit).map(toEntry);
}

function summarize(type, p) {
  switch (type) {
    case "TransitionTaken":
      return `${p.from ?? "-"} -> ${p.to} via ${p.edgeId}`;
    case "BlockedAttempt":
      return `blocked ${p.from ?? "-"} -> ${p.to}: ${p.reason}`;
    case "SoftViolation":
      return `soft violation on ${p.edgeId}: ${p.reason}`;
    case "RewardApplied":
      return `reward ${p.value} over ${p.scopes.length} scopes`;
    case "NodeUpserted":
      return `node ${p.id} (${p.kind})`;
    case "EdgeUpserted":
      return `edge ${p.id}: ${p.src} -> ${p.dst} [${p.kind}]`;
    case "EdgeRemoved":
      return `edge removed ${p.id}`;
    case "ZoneDefined":
      return `zone ${p.name} (${p.members.length} members)`;
    case "EnforcementChanged":
      return `enforcement ${p.scope} ${p.id} -> ${p.mode}`;
    case "CheckpointCreated":
      return `checkpoint ${p.name} @ ${p.seq}`;
    default:
      return type;
  }
}
