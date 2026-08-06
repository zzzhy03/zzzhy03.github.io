import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { prepareScreening } from "../prepare.mjs";
import { validateScreeningReviews } from "../validate.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(testDirectory, "../fixtures");

async function preparedFixture() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "paper-screening-"));
  const runDirectory = path.join(temporaryRoot, "screening-fixture");
  await mkdir(runDirectory, { recursive: true });
  await Promise.all([
    copyFile(path.join(fixtureRoot, "run/candidates.json"), path.join(runDirectory, "candidates.json")),
    copyFile(path.join(fixtureRoot, "run/manifest.json"), path.join(runDirectory, "manifest.json")),
  ]);
  const prepared = await prepareScreening({
    runDirectory,
    researchConfigFile: path.join(fixtureRoot, "research-config.json"),
    venueRegistryFile: path.join(fixtureRoot, "venue-registry.json"),
    batchSize: 2,
    now: "2026-08-06T00:30:00.000Z",
  });
  return { temporaryRoot, runDirectory, prepared };
}

async function installValidReviews(runDirectory) {
  const reviewsDirectory = path.join(runDirectory, "screening/reviews");
  await mkdir(reviewsDirectory, { recursive: true });
  await Promise.all([
    copyFile(
      path.join(fixtureRoot, "reviews/batch-001.review.json"),
      path.join(reviewsDirectory, "batch-001.review.json"),
    ),
    copyFile(
      path.join(fixtureRoot, "reviews/batch-002.review.json"),
      path.join(reviewsDirectory, "batch-002.review.json"),
    ),
  ]);
  return reviewsDirectory;
}

test("prepare creates lossless local batches with routing and attention policy context", async () => {
  const { runDirectory, prepared } = await preparedFixture();
  assert.equal(prepared.screeningManifest.counts.candidates, 4);
  assert.equal(prepared.screeningManifest.counts.batches, 2);
  assert.equal(prepared.screeningManifest.batching.quotaApplied, false);
  assert.equal(prepared.screeningManifest.guarantees.modelCalled, false);
  assert.equal(prepared.screeningManifest.guarantees.canonicalPapersWritten, false);
  assert.equal(path.dirname(prepared.screeningManifestFile), path.join(runDirectory, "screening"));

  const firstBatch = JSON.parse(
    await readFile(path.join(runDirectory, prepared.batchRecords[0].inputFile), "utf8"),
  );
  assert.equal(firstBatch.candidates[0].screeningContext.retrievalTopicIdsAreFinalClassification, false);
  assert.equal(firstBatch.policyContext.directions.length, 4);
  assert.equal(firstBatch.policyContext.attentionPolicies.continuous.allowIncremental, false);
  assert.match(firstBatch.reviewContract.invariantsZh.join(" "), /cross-routing/);
  assert.match(firstBatch.reviewContract.invariantsZh.join(" "), /abstract-only/);
});

test("validator accepts one contract-valid decision per candidate including cross-routing", async () => {
  const { runDirectory } = await preparedFixture();
  await installValidReviews(runDirectory);
  const result = await validateScreeningReviews({ runDirectory });
  assert.equal(result.candidateCount, 4);
  assert.deepEqual(result.decisionCounts, {
    reject: 1,
    "full-text-review": 1,
    "accept-from-abstract": 1,
    "manual-review": 1,
  });
  assert.equal(result.guarantees.everyCandidateExactlyOnce, true);
});

test("validator rejects duplicate decisions and a missing candidate", async () => {
  const { runDirectory } = await preparedFixture();
  const reviewsDirectory = await installValidReviews(runDirectory);
  const reviewFile = path.join(reviewsDirectory, "batch-002.review.json");
  const review = JSON.parse(await readFile(reviewFile, "utf8"));
  review.decisions[1].candidateId = review.decisions[0].candidateId;
  await writeFile(reviewFile, `${JSON.stringify(review, null, 2)}\n`);
  await assert.rejects(
    () => validateScreeningReviews({ runDirectory }),
    /already has a decision|does not have a reviewer decision/,
  );
});

test("accept-from-abstract cannot claim full-text evidence downstream", async () => {
  const { runDirectory } = await preparedFixture();
  const reviewsDirectory = await installValidReviews(runDirectory);
  const reviewFile = path.join(reviewsDirectory, "batch-001.review.json");
  const review = JSON.parse(await readFile(reviewFile, "utf8"));
  review.decisions[0].evidenceBoundary.downstreamClaimScope = "full-text-required";
  await writeFile(reviewFile, `${JSON.stringify(review, null, 2)}\n`);
  await assert.rejects(
    () => validateScreeningReviews({ runDirectory }),
    /abstract-only evidenceBoundary/,
  );
});
