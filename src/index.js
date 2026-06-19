// Public surface. The DState facade plus the evolve/validate/checkpoint/render/
// history operations, exposed both as standalone functions and (for ergonomics)
// as methods on DState so the agent calls everything through one object. This is
// the API the agent uses to remember, decide, and optimize itself.

import { DState } from "./engine.js";
import * as evolveM from "./evolve.js";
import * as validateM from "./validate.js";
import * as checkpointM from "./checkpoint.js";
import * as renderM from "./render.js";
import { history } from "./history.js";
import { exportState } from "./portability.js";
import { MANIFEST } from "./manifest.js";

const ext = {
  splitState(nodeId, newId, moveEdgeIds) {
    return evolveM.splitState(this, nodeId, newId, moveEdgeIds);
  },
  mergeStates(a, b) {
    return evolveM.mergeStates(this, a, b);
  },
  gc() {
    return evolveM.gc(this);
  },
  migrate(kind, apply, toVersion) {
    return evolveM.migrate(this, kind, apply, toVersion);
  },
  optimize() {
    return evolveM.optimize(this);
  },
  reweight() {
    return evolveM.reweight(this);
  },
  selfIterate() {
    return evolveM.selfIterate(this);
  },
  validate() {
    return validateM.validate(this);
  },
  repair() {
    return validateM.repair(this);
  },
  verifyIntegrity() {
    return validateM.verifyIntegrity(this);
  },
  checkpoint(name) {
    return checkpointM.checkpoint(this, name);
  },
  rollback(name) {
    return checkpointM.rollback(this, name);
  },
  listCheckpoints() {
    return checkpointM.listCheckpoints(this);
  },
  branch(filename) {
    return checkpointM.branch(this, filename);
  },
  merge(branchDs) {
    return checkpointM.merge(this, branchDs);
  },
  discard() {
    return checkpointM.discard(this);
  },
  render() {
    return renderM.render(this);
  },
  metrics() {
    return renderM.metrics(this);
  },
  toMermaid() {
    return renderM.toMermaid(this);
  },
  toDot() {
    return renderM.toDot(this);
  },
  history(filter) {
    return history(this, filter);
  },
  snapshot() {
    return this.store.snapshot();
  },
  compact(retain) {
    return this.store.compact(retain);
  },
  export() {
    return exportState(this);
  },
  /** Machine-readable manifest of the full agent-facing surface. */
  describe() {
    return MANIFEST;
  },
};

Object.assign(DState.prototype, ext);

export { DState };
// Ergonomic alias matching the package name; `import { Adaptogen } from "adaptogen"`.
export { DState as Adaptogen };
export { DStateError, ok, err, isOk, isErr, unwrap, ERROR_CODES } from "./errors.js";
export { DEFAULT_TUNABLES } from "./config.js";
export { compileGuard, evalGuard } from "./guard.js";
export { exportState, importState } from "./portability.js";
export { IdGen, isValidId } from "./ids.js";
export { MANIFEST } from "./manifest.js";
