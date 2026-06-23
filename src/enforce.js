// The enforcement decision: the single place soft/hard is resolved. A transition
// is allowed unless a policy reason applies (failing guard, boundary crossing, or
// an above-off intra policy). Each reason is governed by an enforcement mode; the
// final decision is the strictest of the applicable ones. Edge enforcement "off"
// is the gate that lets an otherwise-blocked crossing through. The whole result
// is a structured trace so explain() can name the exact deciding rule.
// Enforcement is static: off/soft/hard as authored, never auto-promoted/demoted.

const DEC_RANK = { allow: 0, warn: 1, deny: 2 };

export function modeToDecision(mode) {
  return mode === "off" ? "allow" : mode === "soft" ? "warn" : "deny";
}

export function decide(input) {
  const reasons = [];
  const candidates = [];

  // 1. Guard. Governed by the edge override, falling back to the global default.
  const guardViolated = input.guard.present && !input.guard.passed;
  if (guardViolated) {
    const mode = input.edgeEnforcement ?? input.globalDefault;
    const source = input.edgeEnforcement != null ? "edge" : "global";
    reasons.push(`guard failed: ${input.guard.expr ?? "<expr>"}`);
    candidates.push({ decision: modeToDecision(mode), mode, source, reason: "guard" });
  }

  // 2. Boundary crossing. Edge "off" is the gate.
  if (input.crossing) {
    const gated = input.edgeEnforcement === "off";
    const mode = gated ? "off" : input.boundaryEnforcement;
    const source = gated ? "edge" : "zone";
    reasons.push(
      gated
        ? `zone boundary crossing ${input.zoneFrom ?? "?"}->${input.zoneTo ?? "?"} (gated)`
        : `zone boundary crossing ${input.zoneFrom ?? "?"}->${input.zoneTo ?? "?"}`,
    );
    candidates.push({ decision: modeToDecision(mode), mode, source, reason: "boundary" });
  }

  // 3. Intra policy above off (a zone that governs internal moves).
  if (!input.crossing && input.intraEnforcement !== "off") {
    const gated = input.edgeEnforcement === "off";
    const mode = gated ? "off" : input.intraEnforcement;
    const source = gated ? "edge" : "zone";
    reasons.push(`intra-zone policy ${input.intraEnforcement}`);
    candidates.push({ decision: modeToDecision(mode), mode, source, reason: "intra" });
  }

  // Strictest candidate wins; deterministic by registration order on ties.
  let winner = { decision: "allow", mode: "off", source: "none", reason: null };
  for (const c of candidates) if (DEC_RANK[c.decision] > DEC_RANK[winner.decision]) winner = c;

  return {
    decision: winner.decision,
    enforcementSource: winner.source,
    effectiveEnforcement: winner.mode,
    guard: {
      present: input.guard.present,
      passed: input.guard.passed,
      ...(guardViolated ? { reason: input.guard.expr } : {}),
    },
    boundary: {
      crossing: input.crossing,
      gated: input.edgeEnforcement === "off" && input.crossing,
      ...(input.zoneFrom ? { zoneFrom: input.zoneFrom } : {}),
      ...(input.zoneTo ? { zoneTo: input.zoneTo } : {}),
    },
    reasons,
  };
}
