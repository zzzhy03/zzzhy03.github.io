import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDecisionLedgerDelta, buildRunPolicyDescriptor, mergeDecisionLedger,
  emptyDecisionLedger, verifyDecisionLedgerImports, verifyLedgerSnapshotMatch,
} from "../../decision-ledger.mjs";
import { finalizationStatus, nextStep, runFinalize } from "../../pipeline.mjs";
import { sha256, jsonBytes } from "../files.mjs";

const legacyRun = "paper-reading-20260807-094202";
function write(root, file, value) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), jsonBytes(value));
}
function pin(root, file) { return { file, sha256: sha256(readFileSync(path.join(root, file))) }; }
function legacyFixture(t, runId = legacyRun, schemaVersion = 2) {
  const root = mkdtempSync(path.join(os.tmpdir(), "legacy-migration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = `local-assets/paper-reading/runs/${runId}`;
  const discovery = { schemaVersion: 1, runId, generatedAt: "2026-08-07T00:00:00Z", configuration: { selectedTopicIds: [] } };
  const screening = { schemaVersion: 1, runId,
    sourceInputs: { researchConfig: { sha256: "a".repeat(64), status: "active" }, venueRegistry: { sha256: "b".repeat(64), status: "active" } },
    reviewContract: { schemaVersion: 1, kind: "fixture-contract" } };
  write(root, `${run}/manifest.json`, discovery);
  write(root, `${run}/screening/screening-manifest.json`, screening);
  write(root, `${run}/candidates.json`, { schemaVersion: 1, runId, candidates: [{
    discoveryId: "fixture-paper", title: "Synthetic legacy paper", abstract: "Fixture abstract", authors: ["Fixture"],
    identifiers: { arxiv: ["2608.12345"] }, arxivVersion: 1, sourceRecords: [{
      source: "arxiv", sourceRecordId: "2608.12345v1", url: "https://arxiv.org/abs/2608.12345v1",
    }],
  }] });
  const screeningFile = `${run}/screening/reviews/batch-001.review.json`;
  write(root, screeningFile, { runId, reviewedAt: "2026-08-07T01:00:00Z", decisions: [{ candidateId: "fixture-paper", decision: "full-text-review", reasonCodes: [] }] });
  const reviewFile = `${run}/fulltext/reviews/2608.12345v1.json`;
  write(root, reviewFile, { schemaVersion, runId, candidateId: "fixture-paper", paperId: "arxiv:2608.12345", decision: "reject", reviewedAt: "2026-08-07T02:00:00Z" });
  const receipt = { schemaVersion: 1, kind: "paper-reading-run-receipt", runId, status: "content-verified",
    screening: { reviews: [pin(root, screeningFile)] }, fulltext: { reviews: [pin(root, reviewFile)] } };
  const receiptFile = "content/paper-reading/runs/2026-08-07.json";
  write(root, receiptFile, receipt);
  return { root, runDirectory: path.join(root, run), run, runId, discovery, screening, receipt, receiptFile, reviewFile };
}

test("schema 2 receipt-pinned legacy rebuild keeps historical fingerprint and observation IDs", (t) => {
  const f = legacyFixture(t);
  const delta = buildDecisionLedgerDelta({ ...f, historicalReceipt: f.receipt });
  assert.equal(delta.policy.fulltextSchemaVersion, 2);
  assert.equal(delta.policy.fingerprint, buildRunPolicyDescriptor(f.discovery, f.screening, { fulltextSchemaVersion: 2 }).fingerprint);
  const current = buildDecisionLedgerDelta(f);
  assert.equal(current.policy.fulltextSchemaVersion, 3);
  assert.notEqual(current.policy.fingerprint, delta.policy.fingerprint);
  assert.notEqual(current.observations[0].observationId, delta.observations[0].observationId);
  const deltaFile = `${f.run}/decision-ledger/delta.json`;
  write(f.root, deltaFile, delta);
  const deltaBytes = readFileSync(path.join(f.root, deltaFile)), receiptBytes = readFileSync(path.join(f.root, f.receiptFile));
  const ledger = mergeDecisionLedger({ ledger: emptyDecisionLedger(), delta,
    deltaArtifact: pin(f.root, deltaFile), receiptArtifact: pin(f.root, f.receiptFile) });
  assert.deepEqual(verifyDecisionLedgerImports({ ledger, root: f.root }).map((item) => item.verified), [true]);
  const snapshotEntry = { ...delta.observations[0],
    sourceCandidateId: delta.observations[0].candidateId,
    sourceImport: { delta: pin(f.root, deltaFile), receipt: pin(f.root, f.receiptFile) } };
  assert.equal(verifyLedgerSnapshotMatch({ entry: snapshotEntry, root: f.root }).verified, true);
  assert.deepEqual(readFileSync(path.join(f.root, deltaFile)), deltaBytes);
  assert.deepEqual(readFileSync(path.join(f.root, f.receiptFile)), receiptBytes);
  write(f.root, f.reviewFile, { schemaVersion: 2, runId: f.runId, changed: true });
  assert.equal(verifyDecisionLedgerImports({ ledger, root: f.root })[0].verified, false);
  assert.equal(verifyLedgerSnapshotMatch({ entry: snapshotEntry, root: f.root }).verified, false);
});

test("legacy reconstruction refuses unknown run provenance, mixed schema and unpinned extra reviews", (t) => {
  const unknown = legacyFixture(t, "unknown-legacy-run");
  assert.throws(() => buildDecisionLedgerDelta({ ...unknown, historicalReceipt: unknown.receipt }), /recognized/);
  const wrongSchema = legacyFixture(t, legacyRun, 3);
  assert.throws(() => buildDecisionLedgerDelta({ ...wrongSchema, historicalReceipt: wrongSchema.receipt }), /schema/);
  const extra = legacyFixture(t);
  write(extra.root, `${extra.run}/fulltext/reviews/extra.json`, { schemaVersion: 2, runId: extra.runId });
  assert.throws(() => buildDecisionLedgerDelta({ ...extra, historicalReceipt: extra.receipt }), /review set differs/);
});

test("daily status advances through watermark; backfill/updates/conference proceed directly to publication", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mode-migration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stages = Object.fromEntries(["discovery", "screening", "fulltext", "backlog", "promotion", "receipt", "decisionLedger"].map((name) => [name, { state: "complete" }]));
  for (const mode of ["daily", "backfill", "updates", "conference"]) {
    const discovery = { runId: "mode-test", window: { mode, end: "2026-10-20T00:00:00Z" } };
    stages.finalization = finalizationStatus(discovery, stages.receipt, stages.decisionLedger, {});
    assert.equal(nextStep(stages, "fixture-digest.json"), mode === "daily" ? "finalize-the-verified-run-watermark" : "publish-separately-then-resume-the-next-run");
    if (mode !== "daily") {
      const run = path.join(root, mode); write(root, `${mode}/manifest.json`, { window: { mode } });
      await assert.rejects(runFinalize({}, root, run), /cannot advance the daily watermark/);
    } else {
      stages.finalization = finalizationStatus(discovery, stages.receipt, stages.decisionLedger, {
        lastRunId: discovery.runId, lastSuccessfulRunAt: discovery.window.end,
      });
      assert.equal(nextStep(stages, "fixture-digest.json"), "publish-separately-then-resume-the-next-run");
    }
  }
});
