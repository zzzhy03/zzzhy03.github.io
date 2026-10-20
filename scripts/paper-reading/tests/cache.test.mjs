import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, access, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyCachePlan, planCache, removeVerifiedSources, restoreCache } from "../cache.mjs";
import { verifyRemovedPdf } from "../lib/source-receipt.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paper-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = "completed", run = path.join(root, "local-assets/paper-reading/runs", runId);
  const bytes = Buffer.from("%PDF-reviewed-exact-bytes"), file = path.join(run, "fulltext/sources/2608.10001v1.pdf");
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
  const reviewFile = path.join(run, "fulltext/reviews/2608.10001v1.json");
  await mkdir(path.dirname(reviewFile), { recursive: true });
  const review = { runId, arxivVersion: "2608.10001v1", decision: "accept-skim", source: { scope: "full_text", pdfPath: path.relative(root, file), pdfSha256: hash(bytes), pageCount: 4 } };
  await writeFile(reviewFile, JSON.stringify(review));
  const receipt = { status: "content-verified", runId, generatedAt: "2026-08-01T00:00:00Z",
    discovery: { window: { mode: "daily", end: "2026-08-01T00:00:00Z" } },
    fulltext: { reviews: [{ file: path.relative(root, reviewFile), sha256: hash(await readFile(reviewFile)) }] } };
  const receiptFile = path.join(root, "content/paper-reading/runs/2026-08-01.json");
  await mkdir(path.dirname(receiptFile), { recursive: true }); await writeFile(receiptFile, JSON.stringify(receipt));
  const stateFile = path.join(root, "content/paper-reading/state/discovery-state.json");
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ lastSuccessfulRunAt: "2026-08-01T00:00:00Z" }));
  return { root, run, runId, bytes, file, reviewFile, receiptFile, receipt, review };
}

test("cleanup plans protect orphan PDFs but include completed defer reviews", async (t) => {
  const f = await fixture(t);
  const orphan = path.join(f.run, "fulltext/sources/comparison.pdf"); await writeFile(orphan, "orphan");
  const plan = await planCache({ root: f.root, now: "2026-10-16T00:00:00Z" });
  assert.equal(plan.targetCount, 1); assert.equal(plan.protectedPdfCount, 1);
  assert.equal(plan.reclaimableBytes, f.bytes.length); await access(f.file);
  f.review.decision = "defer"; await writeFile(f.reviewFile, JSON.stringify(f.review));
  f.receipt.fulltext.reviews[0].sha256 = hash(await readFile(f.reviewFile)); await writeFile(f.receiptFile, JSON.stringify(f.receipt));
  assert.equal((await planCache({ root: f.root })).targetCount, 1);
});

test("prune journals receipts and exact bytes; restore checks the hash; evidence remains", async (t) => {
  const f = await fixture(t), original = await readFile(f.reviewFile);
  const plan = await planCache({ root: f.root, now: "2026-10-16T00:00:00Z" });
  assert.equal((await applyCachePlan(plan)).removedCount, 1);
  await assert.rejects(access(f.file)); assert.deepEqual(await readFile(f.reviewFile), original);
  await assert.rejects(restoreCache({ root: f.root, runDirectory: f.run, fetchImpl: async () => new Response("wrong bytes") }), /differ/);
  assert.equal((await restoreCache({ root: f.root, runDirectory: f.run, fetchImpl: async () => new Response(f.bytes) })).restored, 1);
  assert.deepEqual(await readFile(f.file), f.bytes);
});

test("cache refuses changed evidence and symlink targets", async (t) => {
  const f = await fixture(t);
  const plan = await planCache({ root: f.root, now: "2026-10-16T00:00:00Z" });
  await writeFile(f.file, "changed");
  await assert.rejects(applyCachePlan(plan), /changed/);
  assert.equal((await planCache({ root: f.root })).targetCount, 0);
  await rm(f.file); await symlink(f.reviewFile, f.file);
  await assert.rejects(applyCachePlan(plan), /Symlink/);
});

test("a just-verified PDF is immediately removable without an age or size threshold", async (t) => {
  const f = await fixture(t);
  const plan = await planCache({ root: f.root, now: "2026-08-01T00:00:00Z" });
  assert.equal(plan.targetCount, 1); assert.equal(plan.targets[0].reason, "review-verified");
});

test("automatic cleanup respects its switch and preserves a verifiable receipt after removal", async (t) => {
  const f = await fixture(t);
  assert.equal((await removeVerifiedSources({ root: f.root, runDirectory: f.run })).enabled, false);
  await access(f.file);
  await writeFile(path.join(f.root, "content/paper-reading/pipeline-config.json"), JSON.stringify({ storage: { automaticPrune: true, pdfRetention: "until-verified" } }));
  assert.equal((await removeVerifiedSources({ root: f.root, runDirectory: f.run })).removedCount, 1);
  assert.equal((await removeVerifiedSources({ root: f.root, runDirectory: f.run })).removedCount, 0);
  assert.equal(verifyRemovedPdf({ root: f.root, reviewFile: f.reviewFile, review: f.review }).valid, true);
  f.review.source.pageCount = 5;
  assert.equal(verifyRemovedPdf({ root: f.root, reviewFile: f.reviewFile, review: f.review }).valid, false);
  f.review.source.pageCount = 4;
  await writeFile(f.receiptFile, JSON.stringify({ ...f.receipt, generatedAt: "2026-08-02T00:00:00Z" }));
  assert.equal(verifyRemovedPdf({ root: f.root, reviewFile: f.reviewFile, review: f.review }).valid, false);
});

test("unfinished daily runs stay protected and per-run cleanup cannot touch another run", async (t) => {
  const f = await fixture(t);
  const stateFile = path.join(f.root, "content/paper-reading/state/discovery-state.json");
  await writeFile(stateFile, JSON.stringify({ lastSuccessfulRunAt: "2026-07-01T00:00:00Z" }));
  assert.equal((await planCache({ root: f.root })).targetCount, 0);
  await writeFile(stateFile, JSON.stringify({ lastSuccessfulRunAt: "2026-08-01T00:00:00Z" }));
  const another = path.join(f.root, "local-assets/paper-reading/runs/another"); await mkdir(another);
  assert.equal((await planCache({ root: f.root, runDirectory: another })).targetCount, 0);
  await assert.rejects(planCache({ root: f.root, runDirectory: path.join(f.root, "outside") }), /directly under runs/);
});
