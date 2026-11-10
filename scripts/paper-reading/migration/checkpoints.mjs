import { ID, SHA256, COMMIT, sha256, jsonBytes, verifyRecord, writeImmutable } from "./files.mjs";
import { assertLease } from "./lease.mjs";

export const STAGES = new Set([
  "discovery", "screening", "fulltext", "content", "receipt-ledger",
  "finalize", "publication-commit", "publication-push", "publication-verify",
]);
const MODES = new Set(["daily", "backfill", "updates", "conference"]);
const UNIT = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,239}$/;
const clone = (value) => structuredClone(value);
const digest = (value) => sha256(jsonBytes(value));

export function newCheckpoint({ runId, mode, window, repositoryBaseCommit, codeSnapshotSha256, policyFingerprint }) {
  if (!ID.test(runId) || !MODES.has(mode) || !COMMIT.test(repositoryBaseCommit) ||
      !SHA256.test(codeSnapshotSha256) || !/^sha256:[a-f0-9]{64}$/.test(policyFingerprint) ||
      !window || Object.keys(window).sort().join(",") !== "end,start" ||
      !Number.isFinite(Date.parse(window.start)) || !Number.isFinite(Date.parse(window.end)) ||
      Date.parse(window.start) >= Date.parse(window.end)) {
    throw new Error("Invalid frozen checkpoint context.");
  }
  return {
    schemaVersion: 1, kind: "paper-reading-checkpoint", sequence: 0, parentSha256: null,
    context: { runId, mode, window: { start: window.start, end: window.end },
      repositoryBaseCommit, codeSnapshotSha256, policyFingerprint },
    units: {},
  };
}

function validate(checkpoint) {
  if (checkpoint?.schemaVersion !== 1 || checkpoint?.kind !== "paper-reading-checkpoint" ||
      !Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 0 ||
      (checkpoint.sequence === 0 ? checkpoint.parentSha256 !== null : !SHA256.test(checkpoint.parentSha256)) ||
      !checkpoint.units || typeof checkpoint.units !== "object" || Array.isArray(checkpoint.units)) {
    throw new Error("Invalid checkpoint.");
  }
  newCheckpoint(checkpoint.context);
  for (const [id, unit] of Object.entries(checkpoint.units)) {
    if (!UNIT.test(id) || ["__proto__", "constructor", "prototype"].includes(id) ||
        !STAGES.has(unit.stage) || !SHA256.test(unit.inputSha256) ||
        !Array.isArray(unit.dependencies) || !["intent", "complete"].includes(unit.state) ||
        (unit.state === "complete" && !Array.isArray(unit.outputs))) throw new Error("Invalid checkpoint unit.");
  }
}

function next(checkpoint) {
  validate(checkpoint);
  return { ...clone(checkpoint), sequence: checkpoint.sequence + 1, parentSha256: digest(checkpoint) };
}

// Persist an intent BEFORE starting a side effect. A recovered intent is uncertain:
// the executor must reconcile existing output; it must not automatically rerun the action.
export function beginUnit(checkpoint, { id, stage, inputSha256, dependencies = [] }) {
  validate(checkpoint);
  if (!UNIT.test(id) || ["__proto__", "constructor", "prototype"].includes(id) ||
      !STAGES.has(stage) || !SHA256.test(inputSha256) || !Array.isArray(dependencies) ||
      dependencies.some((value) => !UNIT.test(value)) ||
      new Set(dependencies).size !== dependencies.length || dependencies.includes(id)) throw new Error("Invalid work unit.");
  if (stage === "finalize" && checkpoint.context.mode !== "daily") throw new Error("Only daily runs finalize the watermark.");
  const request = { stage, inputSha256, dependencies: [...dependencies].sort() };
  const existing = checkpoint.units[id];
  if (existing) {
    if (digest({ stage: existing.stage, inputSha256: existing.inputSha256, dependencies: existing.dependencies }) !== digest(request)) {
      throw new Error("Unit identity reused with changed inputs.");
    }
    return clone(checkpoint);
  }
  if (Object.values(checkpoint.units).some((unit) => unit.state === "intent")) {
    throw new Error("Reconcile the outstanding intent before starting more work.");
  }
  for (const dependency of dependencies) {
    if (checkpoint.units[dependency]?.state !== "complete") throw new Error("Dependency is not complete.");
  }
  const after = next(checkpoint);
  after.units[id] = { ...request, state: "intent" };
  return after;
}

export function completeUnit(checkpoint, { id, root, outputs }) {
  validate(checkpoint);
  const unit = checkpoint.units[id];
  if (!unit || !Array.isArray(outputs) || !outputs.length) throw new Error("A persisted intent and output proof are required.");
  const sorted = [...outputs].sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(sorted.map((entry) => entry.path)).size !== sorted.length) throw new Error("Duplicate output proof.");
  for (const entry of sorted) verifyRecord(root, entry);
  if (unit.state === "complete") {
    if (digest(unit.outputs) !== digest(sorted)) throw new Error("Completed unit output changed.");
    return clone(checkpoint);
  }
  const after = next(checkpoint);
  after.units[id] = { ...unit, state: "complete", outputs: sorted };
  return after;
}

export function resumePlan(checkpoint, root, expectedContext) {
  validate(checkpoint);
  const frozen = newCheckpoint(expectedContext).context;
  if (Object.keys(expectedContext).length !== Object.keys(frozen).length ||
      digest(checkpoint.context) !== digest(frozen)) {
    throw new Error("Frozen run context changed.");
  }
  const skip = [], uncertain = [];
  for (const [id, unit] of Object.entries(checkpoint.units)) {
    if (unit.state === "intent") { uncertain.push(id); continue; }
    for (const output of unit.outputs) verifyRecord(root, output);
    skip.push(id);
  }
  return { skip, uncertain, mayStartNewWork: uncertain.length === 0 };
}

export function saveCheckpoint(directory, checkpoint) {
  validate(checkpoint);
  const bytes = jsonBytes(checkpoint);
  const file = `${checkpoint.context.runId}/${String(checkpoint.sequence).padStart(8, "0")}-${sha256(bytes)}.json`;
  writeImmutable(directory, file, bytes);
  return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
}

export function loadCheckpoint(directory, pin, { previousSha256 } = {}) {
  const checkpoint = JSON.parse(verifyRecord(directory, pin));
  validate(checkpoint);
  if (previousSha256 !== undefined && checkpoint.parentSha256 !== previousSha256) throw new Error("Checkpoint chain mismatch.");
  return checkpoint;
}

// This is a fail-closed publication preflight, not a push command. A caller must
// supply an independently observed durable state commit, exact public base and lease.
export function publicationPlan({ checkpoint, durableState, observedStateCommit, expectedCheckpoint,
  root, control, lease, now, publicHead, publicCommit, pushedCommit = null, verifiedCommit = null }) {
  validate(checkpoint);
  assertLease(control, lease, now);
  if (control.active.runId !== checkpoint.context.runId ||
      control.checkpoint?.sha256 !== digest(checkpoint) ||
      control.checkpoint?.sequence !== checkpoint.sequence) throw new Error("Writer control pins another checkpoint.");
  if (!root || !resumePlan(checkpoint, root, checkpoint.context).mayStartNewWork) {
    throw new Error("Publication requires verified outputs and no uncertain intents.");
  }
  if (!durableState || !COMMIT.test(durableState.commit) || durableState.commit !== observedStateCommit ||
      durableState.checkpointSha256 !== digest(checkpoint) || expectedCheckpoint !== digest(checkpoint)) {
    throw new Error("Checkpoint is not acknowledged at the pinned durable state commit.");
  }
  for (const stage of ["content", "receipt-ledger", ...(checkpoint.context.mode === "daily" ? ["finalize"] : [])]) {
    if (!Object.values(checkpoint.units).some((unit) => unit.stage === stage && unit.state === "complete")) {
      throw new Error(`Publication prerequisite incomplete: ${stage}`);
    }
  }
  if (!COMMIT.test(publicCommit)) throw new Error("Exact publication commit required.");
  if (pushedCommit === null && publicHead !== checkpoint.context.repositoryBaseCommit && publicHead !== publicCommit) {
    throw new Error("Public repository base changed; do not rebase or force-push.");
  }
  if (pushedCommit && pushedCommit !== publicCommit) throw new Error("Publication commit mismatch.");
  if (pushedCommit && publicHead !== publicCommit) throw new Error("Public HEAD no longer acknowledges the publication.");
  if (verifiedCommit && verifiedCommit !== publicCommit) throw new Error("Pages verification is for another commit.");
  if (verifiedCommit && publicHead !== publicCommit) throw new Error("Publication has not been observed at public HEAD.");
  return {
    next: verifiedCommit ? "complete" : pushedCommit || publicHead === publicCommit ? "verify-exact-publication" : "push-exact-commit",
    commit: publicCommit,
  };
}
