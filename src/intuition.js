// Intuition = a learned next-move prior over transitions. Each edge accrues
// visits and an ema reward; suggest() ranks the legal moves with an explore term
// (UCB by default) so a high-reward but rarely-tried edge still surfaces. Reward
// influence decays with seq distance so stale paths lose their pull, and every
// suggestion carries a confidence so the agent knows when the data is thin.

/** ema reward decayed by recency: halves every `halfLife` seqs of staleness. */
export function decayedReward(stat, currentSeq, halfLife) {
  if (!stat) return 0;
  const age = Math.max(0, currentSeq - stat.lastSeq);
  const factor = Math.pow(0.5, age / Math.max(1, halfLife));
  return stat.emaReward * factor;
}

/** [0,1): grows with visits, so thin data reports low confidence. */
export function confidence(visits) {
  return visits / (visits + 4);
}

export function rank(moves, cfg, currentSeq, rand) {
  const totalVisits = moves.reduce((a, m) => a + (m.stat?.visits ?? 0), 0);
  const scored = moves.map((m) => {
    const visits = m.stat?.visits ?? 0;
    const rewardTerm = decayedReward(m.stat, currentSeq, cfg.decayHalfLife);
    const weightTerm = Math.log(Math.max(1e-9, m.weight));
    const exploit = rewardTerm + weightTerm;
    let explore;
    if (cfg.explore === "greedy") {
      explore = 0;
    } else if (cfg.explore === "epsilon") {
      explore = rand() < cfg.epsilon ? rand() : 0;
    } else {
      // UCB1
      explore = cfg.ucbC * Math.sqrt(Math.log(totalVisits + 1) / (visits + 1));
    }
    return {
      edgeId: m.edgeId,
      to: m.to,
      score: exploit + explore,
      confidence: confidence(visits),
      enforcement: m.enforcement,
      visits,
      emaReward: m.stat?.emaReward ?? 0,
      // Why this move ranks where it does: score = reward + weight + explore.
      breakdown: { reward: rewardTerm, weight: weightTerm, explore },
    };
  });
  // Deterministic: sort by score desc, then edgeId for ties.
  scored.sort((a, b) => (b.score - a.score) || (a.edgeId < b.edgeId ? -1 : 1));
  return scored;
}
