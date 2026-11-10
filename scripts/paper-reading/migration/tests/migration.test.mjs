import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, cpSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { artifactRole, inventoryState, exportState, verifyBundle, restoreState } from "../state.mjs";
import { jsonBytes, sha256, record, assertNoCredentials } from "../files.mjs";
import {
  newCheckpoint, beginUnit, completeUnit, resumePlan, saveCheckpoint, loadCheckpoint, publicationPlan,
} from "../checkpoints.mjs";
import {
  emptyControl, acquireLease, assertLease, checkpointControl, renewLease, releaseLease,
  localGit, commitControlLocal,
} from "../lease.mjs";

const context = { repositoryBaseCommit: "a".repeat(40), codeSnapshotSha256: "b".repeat(64) };
const run = "local-assets/paper-reading/runs/fixture-run";
function temp(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "paper-migration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(root, file, bytes) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), bytes);
}
function fixture(t) {
  const root = temp(t);
  const source = path.join(root, "source"), bundle = path.join(root, "bundle"), target = path.join(root, "target");
  const data = new Map([
    [`${run}/manifest.json`, Buffer.from('{\r\n "schemaVersion":1, "runId":"fixture-run", "window":{"mode":"daily"}\r\n}\r\n')],
    [`${run}/candidates.json`, jsonBytes({ schemaVersion: 1, runId: "fixture-run", candidates: [] })],
    [`${run}/screening/reviews/batch-001.review.json`, jsonBytes({ runId: "fixture-run", decisions: [] })],
    ["content/paper-reading/state/discovery-state.json", jsonBytes({ schemaVersion: 1, lastRunId: "fixture-run" })],
  ]);
  for (const [file, bytes] of data) write(source, file, bytes);
  write(source, `${run}/fulltext/sources/example.pdf`, Buffer.from("%PDF-synthetic"));
  write(source, `${run}/audit/invocation-baseline.json`, jsonBytes({ unrelated: "excluded synthetic context" }));
  return { root, source, bundle, target, data };
}
function rewriteManifest(bundle, change) {
  const file = path.join(bundle, "manifest.json");
  const manifest = JSON.parse(readFileSync(file));
  change(manifest);
  const bytes = jsonBytes(manifest); writeFileSync(file, bytes);
  return sha256(bytes);
}

test("state round-trip preserves original CRLF/spacing bytes; restore is idempotent and excludes PDF/audit", (t) => {
  const f = fixture(t);
  const inventory = inventoryState(f.source);
  assert.equal(inventory.fileCount, 4);
  assert.equal(inventory.blocked.length, 0);
  assert.deepEqual(new Set(inventory.excluded.map((entry) => entry.reason)), new Set(["pdf-excluded", "historical-audit-or-log"]));
  const pin = exportState({ root: f.source, destination: f.bundle, context });
  const result = restoreState({ bundle: f.bundle, target: f.target, manifestSha256: pin.manifestSha256, expectedContext: context });
  assert.equal(result.installed, 4);
  for (const [file, bytes] of f.data) assert.deepEqual(readFileSync(path.join(f.target, file)), bytes);
  assert.equal(restoreState({ bundle: f.bundle, target: f.target, manifestSha256: pin.manifestSha256, expectedContext: context }).installed, 0);
});

test("tampered raw bytes and untrusted manifest pins fail before any target installation", (t) => {
  const f = fixture(t);
  const pin = exportState({ root: f.source, destination: f.bundle, context });
  write(f.bundle, `files/${run}/manifest.json`, Buffer.from("{}"));
  assert.throws(() => restoreState({ bundle: f.bundle, target: f.target, manifestSha256: pin.manifestSha256, expectedContext: context }), /hash\/length/);
  assert.throws(() => verifyBundle({ bundle: f.bundle, manifestSha256: "0".repeat(64) }), /Manifest hash/);
});

for (const [name, mutate, expected] of [
  ["path traversal", (m) => { m.files[0].path = "../outside"; }, /Unsafe/],
  ["absolute path", (m) => { m.files[0].path = "/outside"; }, /Unsafe/],
  ["duplicate path", (m) => { m.files.push(m.files[0]); }, /Duplicate/],
  ["unknown schema", (m) => { m.schemaVersion = 99; }, /Unsupported/],
  ["unknown role", (m) => { m.files[0].role = "arbitrary"; }, /Unknown artifact role/],
]) {
  test(`restore rejects ${name}, even with a freshly supplied manifest pin`, (t) => {
    const f = fixture(t); exportState({ root: f.source, destination: f.bundle, context });
    const manifestSha256 = rewriteManifest(f.bundle, mutate);
    assert.throws(() => verifyBundle({ bundle: f.bundle, manifestSha256 }), expected);
  });
}

test("symlink source, bundle and target ancestors are rejected; existing files are never overwritten", (t) => {
  const f = fixture(t), outside = path.join(f.root, "outside");
  mkdirSync(outside);
  const pin = exportState({ root: f.source, destination: f.bundle, context });
  write(f.target, `${run}/manifest.json`, Buffer.from("conflict"));
  assert.throws(() => restoreState({ bundle: f.bundle, target: f.target, manifestSha256: pin.manifestSha256, expectedContext: context }), /hash\/length/);
  assert.equal(readFileSync(path.join(f.target, run, "manifest.json"), "utf8"), "conflict");
  rmSync(f.target, { recursive: true });
  symlinkSync(outside, f.target);
  assert.throws(() => restoreState({ bundle: f.bundle, target: f.target, manifestSha256: pin.manifestSha256, expectedContext: context }), /Symlink/);
  const manifestFile = path.join(f.source, run, "manifest.json");
  rmSync(manifestFile); symlinkSync(path.join(outside, "absent"), manifestFile);
  assert.equal(inventoryState(f.source).blocked.length, 1);
  const bundledFile = path.join(f.bundle, "files", run, "manifest.json");
  rmSync(bundledFile); symlinkSync(path.join(outside, "absent"), bundledFile);
  assert.throws(() => verifyBundle({ bundle: f.bundle, manifestSha256: pin.manifestSha256 }), /Symlink/);
});

test("unexpected payloads, credential-shaped fields and context mismatches fail closed", (t) => {
  const f = fixture(t);
  const pin = exportState({ root: f.source, destination: f.bundle, context });
  assert.throws(() => restoreState({ bundle: f.bundle, target: f.target, manifestSha256: pin.manifestSha256,
    expectedContext: { ...context, repositoryBaseCommit: "c".repeat(40) } }), /context mismatch/);
  write(f.bundle, "files/extra.json", jsonBytes({ example: true }));
  assert.throws(() => verifyBundle({ bundle: f.bundle, manifestSha256: pin.manifestSha256 }), /Unmanifested/);
  write(f.source, `${run}/manifest.json`, jsonBytes({ runId: "fixture-run", access_token: "synthetic-secret" }));
  assert.equal(inventoryState(f.source).blocked.length, 1);
  assert.throws(() => exportState({ root: f.source, destination: path.join(f.root, "blocked"), context }), /Export blocked/);
  assert.equal(artifactRole(`${run}/.env`), null);
});

test("research slugs are not mistaken for key prefixes; selected artifacts cannot impersonate another run", (t) => {
  assert.doesNotThrow(() => assertNoCredentials(jsonBytes({ title: "task-adaptive-grounded-programmers-using-vlms" }), { json: true }));
  assert.throws(() => assertNoCredentials(jsonBytes({ value: `sk-${"x".repeat(30)}` }), { json: true }), /Sensitive/);
  const f = fixture(t);
  write(f.source, `${run}/manifest.json`, jsonBytes({ runId: "different-run" }));
  assert.equal(inventoryState(f.source).blocked.length, 1);
  assert.throws(() => exportState({ root: f.source, destination: path.join(f.source, "bundle"), context }), /blocked|outside/);
});

test("only receipt-pinned withdrawal notices are included and their bytes are revalidated", (t) => {
  const f = fixture(t);
  const notice = `${run}/fulltext/sources/withdrawal.html`, bytes = Buffer.from("<p>Fixture withdrawal</p>");
  write(f.source, notice, bytes);
  write(f.source, "content/paper-reading/runs/fixture.json", jsonBytes({
    runId: "fixture-run", withdrawals: [{ notice: { file: notice, sha256: sha256(bytes) } }],
  }));
  const pin = exportState({ root: f.source, destination: f.bundle, context });
  assert.equal(verifyBundle({ bundle: f.bundle, manifestSha256: pin.manifestSha256 }).manifest.files.find((f) => f.path === notice).role, "withdrawal-notice");
  write(f.source, notice, Buffer.from("changed"));
  assert.ok(inventoryState(f.source).blocked.length > 0);
});

function checkpointContext(mode = "daily") {
  return { ...context, runId: "fixture-run", mode,
    window: { start: "2026-10-19T00:00:00Z", end: "2026-10-20T00:00:00Z" },
    policyFingerprint: `sha256:${"d".repeat(64)}` };
}
test("every checkpoint phase survives fresh-directory recovery; uncertain intent never auto-reruns", (t) => {
  const root = temp(t), store = path.join(root, "checkpoints");
  let state = newCheckpoint(checkpointContext()), previous = null;
  for (const stage of ["discovery", "screening", "fulltext", "content", "receipt-ledger", "finalize"]) {
    state = beginUnit(state, { id: stage, stage, inputSha256: "e".repeat(64), dependencies: previous ? [previous] : [] });
    const intentPin = saveCheckpoint(store, state);
    const copied = path.join(root, `restore-${stage}`);
    cpSync(store, copied, { recursive: true });
    const restored = loadCheckpoint(copied, intentPin);
    const plan = resumePlan(restored, root, checkpointContext());
    assert.deepEqual(plan.uncertain, [stage]);
    assert.equal(plan.mayStartNewWork, false);
    assert.deepEqual(beginUnit(restored, { id: stage, stage, inputSha256: "e".repeat(64), dependencies: previous ? [previous] : [] }), restored);
    const file = `results/${stage}.json`;
    write(root, file, jsonBytes({ synthetic: stage }));
    state = completeUnit(restored, { id: stage, root, outputs: [record(root, file)] });
    const completePin = saveCheckpoint(store, state);
    assert.equal(loadCheckpoint(store, completePin, { previousSha256: intentPin.sha256 }).units[stage].state, "complete");
    assert.ok(resumePlan(state, root, checkpointContext()).skip.includes(stage));
    assert.deepEqual(completeUnit(state, { id: stage, root, outputs: [record(root, file)] }), state);
    previous = stage;
  }
  write(root, "results/discovery.json", Buffer.from("changed"));
  assert.throws(() => resumePlan(state, root, checkpointContext()), /hash\/length/);
});

test("checkpoint identities, dependencies and immutable versions cannot be silently replaced", (t) => {
  const root = temp(t);
  let state = newCheckpoint(checkpointContext());
  assert.throws(() => beginUnit(state, { id: "b", stage: "screening", inputSha256: "e".repeat(64), dependencies: ["a"] }), /Dependency/);
  state = beginUnit(state, { id: "a", stage: "discovery", inputSha256: "e".repeat(64) });
  assert.throws(() => beginUnit(state, { id: "a", stage: "discovery", inputSha256: "f".repeat(64) }), /changed inputs/);
  assert.throws(() => resumePlan(state, root, { ...checkpointContext(), runId: "other" }), /context/);
  assert.throws(() => resumePlan(state, root, { ...checkpointContext(),
    window: { start: "2026-10-18T00:00:00Z", end: "2026-10-20T00:00:00Z" } }), /context/);
  for (const mode of ["backfill", "conference", "updates"]) {
    assert.throws(() => beginUnit(newCheckpoint(checkpointContext(mode)), { id: "x", stage: "finalize", inputSha256: "f".repeat(64) }), /Only daily/);
  }
});

test("publication requires durable checkpoint and exact commit; a push/Pages failure resumes publication only", (t) => {
  const root = temp(t); let checkpoint = newCheckpoint(checkpointContext());
  for (const stage of ["content", "receipt-ledger", "finalize"]) {
    checkpoint = beginUnit(checkpoint, { id: stage, stage, inputSha256: "e".repeat(64) });
    const file = `results/${stage}.json`; write(root, file, jsonBytes({ stage }));
    checkpoint = completeUnit(checkpoint, { id: stage, root, outputs: [record(root, file)] });
  }
  const checkpointSha256 = sha256(jsonBytes(checkpoint)), publicCommit = "f".repeat(40), stateCommit = "1".repeat(40);
  const now = Date.parse("2026-10-20T00:00:00Z");
  const lease = acquireLease(emptyControl(), { owner: "publisher", runId: "fixture-run", now });
  const control = { ...lease, checkpoint: { sha256: checkpointSha256, sequence: checkpoint.sequence } };
  const options = { root, checkpoint, control, lease, now, durableState: { commit: stateCommit, checkpointSha256 },
    expectedCheckpoint: checkpointSha256, observedStateCommit: stateCommit, publicHead: context.repositoryBaseCommit, publicCommit };
  assert.throws(() => publicationPlan({ ...options, observedStateCommit: "2".repeat(40) }), /not acknowledged/);
  assert.throws(() => publicationPlan({ ...options, now: now + 99999999 }), /expired/);
  assert.throws(() => publicationPlan({ ...options, publicHead: "3".repeat(40) }), /base changed/);
  assert.equal(publicationPlan(options).next, "push-exact-commit");
  assert.equal(publicationPlan({ ...options, publicHead: publicCommit }).next, "verify-exact-publication");
  assert.equal(publicationPlan({ ...options, publicHead: publicCommit, pushedCommit: publicCommit }).next, "verify-exact-publication");
  assert.equal(publicationPlan({ ...options, publicHead: publicCommit, pushedCommit: publicCommit, verifiedCommit: publicCommit }).next, "complete");
  assert.throws(() => publicationPlan({ ...options, verifiedCommit: "4".repeat(40) }), /another commit/);
  assert.throws(() => publicationPlan({ ...options, verifiedCommit: publicCommit }), /not been observed/);
  assert.equal(resumePlan(checkpoint, root, checkpointContext()).skip.length, 3);
});

test("two isolated clones compete with ordinary local push: only one lease wins; stale tokens fail", (t) => {
  const root = temp(t), remote = path.join(root, "remote.git"), seed = path.join(root, "seed");
  mkdirSync(seed);
  localGit(root, ["init", "--bare", "--initial-branch=main", remote]);
  localGit(seed, ["init", "--initial-branch=main"]);
  write(seed, "control.json", jsonBytes(emptyControl()));
  localGit(seed, ["add", "control.json"]);
  localGit(seed, ["commit", "--no-gpg-sign", "-m", "Synthetic initial control"]);
  localGit(seed, ["remote", "add", "origin", remote]);
  localGit(seed, ["push", "origin", "main"]);
  const first = path.join(root, "first"), second = path.join(root, "second");
  localGit(root, ["clone", "--no-hardlinks", remote, first]);
  localGit(root, ["clone", "--no-hardlinks", remote, second]);
  const head = localGit(first, ["rev-parse", "HEAD"]), now = Date.parse("2026-10-20T00:00:00Z");
  const a = acquireLease(emptyControl(), { owner: "worker-a", runId: "fixture-run", now });
  const b = acquireLease(emptyControl(), { owner: "worker-b", runId: "fixture-run", now });
  const winner = commitControlLocal({ checkout: first, expectedHead: head, control: a });
  assert.throws(() => commitControlLocal({ checkout: second, expectedHead: head, control: b }), /CAS rejected/);
  const observed = JSON.parse(localGit(remote, ["show", "main:control.json"]));
  assert.deepEqual(observed, a);
  assert.throws(() => assertLease(observed, b, now + 1), /Stale/);
  assert.throws(() => acquireLease(observed, { owner: "worker-b", runId: "other", now: now + 99999999 }), /expiry alone/);
  assert.throws(() => renewLease(observed, a, now + 99999999), /expired/);
  const firstPin = { runId: "fixture-run", sha256: "a".repeat(64), sequence: 0, parentSha256: null };
  assert.throws(() => checkpointControl(observed, b, firstPin, now), /Stale/);
  const completed = checkpointControl(observed, a, firstPin, now);
  assert.throws(() => checkpointControl(completed, a, { ...firstPin, sha256: "b".repeat(64) }, now), /fork/);
  assert.throws(() => checkpointControl(completed, a, { ...firstPin, sha256: "b".repeat(64), sequence: 2, parentSha256: firstPin.sha256 }, now), /chain/);
  assert.equal(checkpointControl(completed, a, { ...firstPin, sha256: "b".repeat(64), sequence: 1, parentSha256: firstPin.sha256 }, now).checkpoint.sequence, 1);
  const released = releaseLease(observed, a);
  const acknowledged = commitControlLocal({ checkout: first, expectedHead: winner.commit, control: released });
  assert.equal(JSON.parse(localGit(remote, ["show", "main:control.json"])).active, null);
  assert.ok(acknowledged.commit);
  const successor = acquireLease(released, { owner: "worker-b", runId: "other", now });
  assert.throws(() => assertLease(successor, a, now), /Stale/);
  localGit(first, ["remote", "set-url", "origin", "https://example.invalid/never-used"]);
  assert.throws(() => commitControlLocal({ checkout: first, expectedHead: acknowledged.commit, control: successor }), /Only a local/);
});
