import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyWorkCleanupPlan,
  createWorkCleanupPlan,
  getPipelineStatus,
  receiptStatus,
  resolveRunDirectory,
  runFinalize,
  runReceipt,
} from "../../pipeline.mjs";
import { validateFulltextReviews } from "../../fulltext/validate.mjs";
import { validatePromotion } from "../../fulltext/validate-promotion.mjs";

const temporaryRoots = [];
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(file) {
  const hash = createHash("sha256");
  hash.update(readFileSync(file));
  return hash.digest("hex");
}

function temporaryRepository() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paper-reading-pipeline-")));
  temporaryRoots.push(root);
  const runs = path.join(root, "local-assets", "paper-reading", "runs");
  mkdirSync(runs, { recursive: true });
  return { root, runs };
}

function createRun(root, runId = "run-001") {
  const runDirectory = path.join(root, "local-assets", "paper-reading", "runs", runId);
  mkdirSync(runDirectory, { recursive: true });
  return runDirectory;
}

function createCompletedEmptyScreeningRun(root, runId = "run-001") {
  const runDirectory = createRun(root, runId);
  writeJson(path.join(runDirectory, "candidates.json"), {
    schemaVersion: 1,
    runId,
    candidates: [],
  });
  writeJson(path.join(runDirectory, "manifest.json"), {
    schemaVersion: 1,
    runId,
    counts: { mergedCandidates: 0 },
    sourceStatus: [{ id: "arxiv", status: "checked" }],
    window: {
      start: "2026-08-06T00:00:00.000Z",
      end: "2026-08-07T00:00:00.000Z",
      lastSuccessfulRunAt: "2026-08-06T00:00:00.000Z",
      overlapHours: 48,
    },
  });
  writeJson(path.join(runDirectory, "screening", "screening-manifest.json"), {
    schemaVersion: 1,
    kind: "paper-reading-screening-manifest",
    runId,
    batches: [],
    counts: { candidates: 0, batches: 0 },
  });
  return runDirectory;
}

function copyCanonicalValidationFixture(root) {
  cpSync(
    path.join(repositoryRoot, "content", "paper-reading"),
    path.join(root, "content", "paper-reading"),
    { recursive: true },
  );
  // Keep the fixture independent of run receipts created by later real daily runs.
  // A copied receipt for the same date would intentionally pin the pre-test digest hash.
  rmSync(path.join(root, "content", "paper-reading", "runs"), {
    recursive: true,
    force: true,
  });
  mkdirSync(path.join(root, "content", "paper-reading", "runs"), { recursive: true });
  writeJson(path.join(root, "content", "paper-reading", "state", "discovery-state.json"), {
    schemaVersion: 1,
    lastSuccessfulRunAt: "2026-08-06T00:00:00.000Z",
    lastRunId: "fixture-previous-run",
    overlapHours: 48,
  });
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  cpSync(
    path.join(repositoryRoot, "scripts", "validate-paper-reading.mjs"),
    path.join(root, "scripts", "validate-paper-reading.mjs"),
  );

  const baseDigest = JSON.parse(
    readFileSync(path.join(root, "content", "paper-reading", "digests", "2026-08-06.json")),
  );
  writeJson(path.join(root, "content", "paper-reading", "digests", "2026-08-07.json"), {
    ...baseDigest,
    date: "2026-08-07",
    generatedAt: "2026-08-07T08:00:00+08:00",
    paperIds: [],
    topicBriefs: baseDigest.topicBriefs.map((brief) => ({ ...brief, paperIds: [] })),
  });
}

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

test("run directories are limited to direct, non-symlink children of the archive root", () => {
  const { root, runs } = temporaryRepository();
  const run = createRun(root);
  assert.equal(resolveRunDirectory(root, run), realpathSync(run));
  assert.throws(() => resolveRunDirectory(root, runs), /one direct child/);

  const nested = path.join(run, "nested");
  mkdirSync(nested);
  assert.throws(() => resolveRunDirectory(root, nested), /one direct child/);

  const outside = path.join(root, "outside");
  mkdirSync(outside);
  assert.throws(() => resolveRunDirectory(root, outside), /one direct child/);

  const link = path.join(runs, "linked-run");
  symlinkSync(run, link, "dir");
  assert.throws(() => resolveRunDirectory(root, link), /symbolic links/);
});

test("cleanup deletes only fulltext/work and preserves audit sources", () => {
  const { root } = temporaryRepository();
  const run = createRun(root);
  const work = path.join(run, "fulltext", "work");
  const source = path.join(run, "fulltext", "sources", "paper.pdf");
  const review = path.join(run, "fulltext", "reviews", "paper.json");
  mkdirSync(path.join(work, "rendered"), { recursive: true });
  mkdirSync(path.dirname(source), { recursive: true });
  mkdirSync(path.dirname(review), { recursive: true });
  writeFileSync(path.join(work, "paper.txt"), "text");
  writeFileSync(path.join(work, "rendered", "page.png"), "png");
  writeFileSync(source, "pdf");
  writeFileSync(review, "{}");

  const plan = createWorkCleanupPlan(run);
  assert.equal(plan.fileCount, 2);
  assert.equal(plan.bytes, 7);
  assert.equal(existsSync(work), true);

  const result = applyWorkCleanupPlan(plan);
  assert.equal(result.deleted, true);
  assert.equal(existsSync(work), false);
  assert.equal(existsSync(source), true);
  assert.equal(existsSync(review), true);
});

test("cleanup refuses a target that changes after planning", () => {
  const { root } = temporaryRepository();
  const run = createRun(root);
  const work = path.join(run, "fulltext", "work");
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, "first.txt"), "first");
  const plan = createWorkCleanupPlan(run);
  writeFileSync(path.join(work, "second.txt"), "second");
  assert.throws(() => applyWorkCleanupPlan(plan), /changed after planning/);
  assert.equal(existsSync(work), true);
});

test("status is read-only and points an unfinished run to screening preparation", async () => {
  const { root } = temporaryRepository();
  const run = createRun(root);
  writeFileSync(
    path.join(run, "candidates.json"),
    `${JSON.stringify({ schemaVersion: 1, runId: "run-001", candidates: [] }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(run, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runId: "run-001",
        counts: { mergedCandidates: 0 },
        sourceStatus: [{ id: "arxiv", status: "checked" }],
        window: { start: "2026-08-05T00:00:00.000Z", end: "2026-08-06T00:00:00.000Z" },
      },
      null,
      2,
    )}\n`,
  );

  const before = createWorkCleanupPlan(run);
  const status = await getPipelineStatus({ root, runDirectory: run });
  const after = createWorkCleanupPlan(run);
  assert.equal(status.stages.discovery.state, "complete");
  assert.equal(status.stages.screening.state, "pending");
  assert.equal(status.nextStep, "prepare-screening");
  assert.deepEqual(after, before);
});

test("an all-full-text run with no selected papers completes receipt and finalization without a backlog file", async () => {
  const { root } = temporaryRepository();
  copyCanonicalValidationFixture(root);
  const run = createCompletedEmptyScreeningRun(root);
  const digest = "content/paper-reading/digests/2026-08-07.json";

  const emptyStatus = await getPipelineStatus({ root, runDirectory: run });
  assert.equal(emptyStatus.stages.screening.state, "complete");
  assert.deepEqual(emptyStatus.stages.fulltext, {
    state: "complete",
    reviewCount: 0,
    expectedCount: 0,
    decisionCounts: {},
    topicCounts: {},
    errors: [],
  });
  assert.equal(emptyStatus.stages.backlog.state, "complete");
  assert.equal(existsSync(path.join(run, "fulltext", "backlog.json")), false);
  assert.equal(existsSync(path.join(run, "fulltext", "reviews")), false);

  const fulltextValidation = validateFulltextReviews({
    root,
    reviewDirectory: path.join(run, "fulltext", "reviews"),
    researchConfig: "content/paper-reading/research-config.json",
    screeningRunDirectory: run,
    selection: "all-full-text",
    expectedCount: 0,
  });
  assert.deepEqual(fulltextValidation.errors, []);
  assert.equal(fulltextValidation.counts.total, 0);

  const promotionValidation = validatePromotion({
    root,
    runDirectory: run,
    reviewDirectory: path.join(run, "fulltext", "reviews"),
    paperDirectory: "content/paper-reading/papers",
    digest,
    expectedCount: 0,
  });
  assert.deepEqual(promotionValidation.errors, []);
  assert.equal(promotionValidation.acceptedCount, 0);

  const receiptResult = await runReceipt(
    { selection: "all-full-text", digest, apply: true },
    root,
    run,
  );
  assert.equal(receiptResult.backlogCount, 0);

  const receiptFile = path.join(root, "content", "paper-reading", "runs", "2026-08-07.json");
  const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
  assert.deepEqual(receipt.fulltext.backlog, { candidateIds: [] });
  assert.equal(
    receipt.watermark.previousLastSuccessfulRunAt,
    "2026-08-06T00:00:00.000Z",
  );

  const recordedStatus = await getPipelineStatus({ root, runDirectory: run, digest });
  assert.equal(
    recordedStatus.stages.receipt.state,
    "complete",
    recordedStatus.stages.receipt.errors.join("\n"),
  );

  const candidatesFile = path.join(run, "candidates.json");
  const originalCandidates = readFileSync(candidatesFile, "utf8");
  writeJson(candidatesFile, {
    ...JSON.parse(originalCandidates),
    testTamper: true,
  });
  const tamperedStatus = await getPipelineStatus({ root, runDirectory: run, digest });
  assert.equal(tamperedStatus.stages.receipt.state, "invalid");
  assert.match(tamperedStatus.stages.receipt.errors.join(" "), /artifact hash changed/);
  writeFileSync(candidatesFile, originalCandidates);

  const finalization = await runFinalize(
    { selection: "all-full-text", digest, apply: true },
    root,
    run,
  );
  assert.deepEqual(finalization.after, {
    lastSuccessfulRunAt: "2026-08-07T00:00:00.000Z",
    lastRunId: "run-001",
  });
});

test("receipt validation binds a non-empty backlog artifact to the current closure", () => {
  const { root } = temporaryRepository();
  const runId = "run-with-backlog";
  const run = createRun(root, runId);
  const candidateId = "candidate:pending";
  writeJson(path.join(run, "candidates.json"), {
    schemaVersion: 1,
    runId,
    candidates: [{ discoveryId: candidateId, title: "Pending paper" }],
  });
  writeJson(path.join(run, "screening", "reviews", "batch-001.review.json"), {
    decisions: [{ candidateId, decision: "full-text-review" }],
  });
  const backlogFile = path.join(run, "fulltext", "backlog.json");
  writeJson(backlogFile, { candidateIds: [candidateId] });

  const digest = path.join(root, "content", "paper-reading", "digests", "2026-08-08.json");
  writeJson(digest, { date: "2026-08-08", paperIds: [] });
  const relativeArtifact = (file) => ({
    file: path.relative(root, file),
    sha256: sha256File(file),
  });
  const receiptFile = path.join(root, "content", "paper-reading", "runs", "2026-08-08.json");
  const receipt = {
    schemaVersion: 1,
    kind: "paper-reading-run-receipt",
    runId,
    digest: relativeArtifact(digest),
    screening: { reviews: [] },
    fulltext: {
      reviews: [],
      backlog: {
        candidateIds: [candidateId],
        ...relativeArtifact(backlogFile),
      },
    },
  };
  writeJson(receiptFile, receipt);
  assert.equal(receiptStatus(root, runId, digest, run).state, "complete");

  writeJson(receiptFile, {
    ...receipt,
    fulltext: {
      ...receipt.fulltext,
      backlog: { ...receipt.fulltext.backlog, candidateIds: ["candidate:other"] },
    },
  });
  const mismatched = receiptStatus(root, runId, digest, run);
  assert.equal(mismatched.state, "invalid");
  assert.match(mismatched.errors.join(" "), /no longer match full-text closure/);

  writeJson(receiptFile, {
    ...receipt,
    fulltext: { ...receipt.fulltext, backlog: { candidateIds: [candidateId] } },
  });
  const unhashed = receiptStatus(root, runId, digest, run);
  assert.equal(unhashed.state, "invalid");
  assert.match(unhashed.errors.join(" "), /must reference its hashed artifact/);
});
