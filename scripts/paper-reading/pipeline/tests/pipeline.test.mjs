import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyWorkCleanupPlan,
  createWorkCleanupPlan,
  getPipelineStatus,
  resolveRunDirectory,
} from "../../pipeline.mjs";

const temporaryRoots = [];

function temporaryRepository() {
  const root = mkdtempSync(path.join(os.tmpdir(), "paper-reading-pipeline-"));
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
