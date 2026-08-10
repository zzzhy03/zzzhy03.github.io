import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildPolicyDescriptor,
  candidateEvidenceFingerprint,
  DECISION_LEDGER_DELTA_KIND,
  mergeDecisionLedger,
  sha256Value,
} from "../../decision-ledger.mjs";
import { buildReviewContract } from "../contract.mjs";
import { prepareScreening } from "../prepare.mjs";
import { validateScreeningReviews } from "../validate.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(testDirectory, "../fixtures");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

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

test("prepare and validator account for receipt-backed exact-version ledger skips", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "paper-screening-ledger-"));
  const runDirectory = path.join(temporaryRoot, "screening-fixture");
  await mkdir(runDirectory, { recursive: true });
  const [candidatePayload, discoveryManifest, researchConfig, venueRegistry] = await Promise.all(
    [
      readFile(path.join(fixtureRoot, "run/candidates.json"), "utf8").then(JSON.parse),
      readFile(path.join(fixtureRoot, "run/manifest.json"), "utf8").then(JSON.parse),
      readFile(path.join(fixtureRoot, "research-config.json"), "utf8").then(JSON.parse),
      readFile(path.join(fixtureRoot, "venue-registry.json"), "utf8").then(JSON.parse),
    ],
  );
  researchConfig.status = "active";
  venueRegistry.status = "active";
  const skippedCandidate = candidatePayload.candidates.at(-1);
  skippedCandidate.arxivVersion = 1;
  skippedCandidate.links[0].href = "https://arxiv.org/abs/2608.10004v1";
  skippedCandidate.sourceRecords = [
    {
      source: "arxiv",
      sourceRecordId: "2608.10004v1",
      url: "https://arxiv.org/abs/2608.10004v1",
    },
  ];
  const researchFile = path.join(temporaryRoot, "research-config.json");
  const venueFile = path.join(temporaryRoot, "venue-registry.json");
  await Promise.all([
    writeFile(
      path.join(runDirectory, "candidates.json"),
      `${JSON.stringify(candidatePayload, null, 2)}\n`,
    ),
    writeFile(
      path.join(runDirectory, "manifest.json"),
      `${JSON.stringify(discoveryManifest, null, 2)}\n`,
    ),
    writeFile(researchFile, `${JSON.stringify(researchConfig, null, 2)}\n`),
    writeFile(venueFile, `${JSON.stringify(venueRegistry, null, 2)}\n`),
  ]);
  const policy = buildPolicyDescriptor({
    researchConfigSha256: sha256(await readFile(researchFile)),
    researchConfigStatus: "active",
    venueRegistrySha256: sha256(await readFile(venueFile)),
    venueRegistryStatus: "active",
    selectedTopicIds: discoveryManifest.configuration.selectedTopicIds,
    reviewContract: buildReviewContract(),
  });
  const priorRunId = "verified-prior-run";
  const sourceCandidateId = skippedCandidate.discoveryId;
  const observationBody = {
    artifactKey: "arxiv:2608.10004@v1",
    paperId: "arxiv:2608.10004",
    exactVersion: "2608.10004v1",
    identityStatus: "exact",
    candidateEvidenceFingerprint: candidateEvidenceFingerprint(skippedCandidate),
    policyFingerprint: policy.fingerprint,
    outcome: "screening-reject",
    stage: "screening",
    skipMode: "terminal",
    runId: priorRunId,
    candidateId: sourceCandidateId,
    title: skippedCandidate.title,
    decidedAt: "2026-08-05T00:00:00.000Z",
    reasonCodes: ["no-topic-fit"],
    revisit: { triggers: ["new-version", "policy-change"] },
    artifacts: {},
  };
  const observation = {
    observationId: sha256Value(observationBody),
    ...observationBody,
  };
  const deltaFile = path.join(temporaryRoot, "prior-delta.json");
  await writeFile(
    deltaFile,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: DECISION_LEDGER_DELTA_KIND,
        policyVersion: 1,
        runId: priorRunId,
        generatedAt: observation.decidedAt,
        policy,
        observations: [observation],
      },
      null,
      2,
    )}\n`,
  );
  const deltaRecord = {
    file: path.relative(temporaryRoot, deltaFile),
    sha256: sha256(await readFile(deltaFile)),
  };
  const receiptFile = path.join(temporaryRoot, "prior-receipt.json");
  await writeFile(
    receiptFile,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: "paper-reading-run-receipt",
        runId: priorRunId,
        status: "content-verified",
        decisionLedger: { delta: deltaRecord },
      },
      null,
      2,
    )}\n`,
  );
  const ledgerFile = path.join(temporaryRoot, "decision-ledger.json");
  await writeFile(
    ledgerFile,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: "paper-reading-decision-ledger",
        policyVersion: 1,
        generatedAt: observation.decidedAt,
        imports: [
          {
            runId: priorRunId,
            generatedAt: observation.decidedAt,
            policyFingerprint: policy.fingerprint,
            observationCount: 1,
            delta: deltaRecord,
            receipt: {
              file: path.relative(temporaryRoot, receiptFile),
              sha256: sha256(await readFile(receiptFile)),
            },
          },
        ],
        observations: [observation],
        summary: {
          papers: 1,
          exactVersions: 1,
          policies: 1,
          observations: 1,
          terminalObservations: 1,
          decisionContexts: 1,
          effectiveOutcomes: { "screening-reject": 1 },
        },
      },
      null,
      2,
    )}\n`,
  );
  skippedCandidate.discoveryId = "candidate:identity-conflict-rerun";
  await writeFile(
    path.join(runDirectory, "candidates.json"),
    `${JSON.stringify(candidatePayload, null, 2)}\n`,
  );

  const prepared = await prepareScreening({
    root: temporaryRoot,
    runDirectory,
    researchConfigFile: researchFile,
    venueRegistryFile: venueFile,
    decisionLedgerFile: ledgerFile,
    batchSize: 2,
    now: "2026-08-06T00:30:00.000Z",
  });
  assert.equal(prepared.screeningManifest.counts.discoveredCandidates, 4);
  assert.equal(prepared.screeningManifest.counts.candidates, 3);
  assert.equal(prepared.screeningManifest.counts.ledgerSkippedCandidates, 1);
  assert.equal(prepared.ledgerSnapshot.matches[0].candidateId, skippedCandidate.discoveryId);
  assert.equal(prepared.ledgerSnapshot.matches[0].sourceCandidateId, sourceCandidateId);

  const reviewsDirectory = path.join(runDirectory, "screening/reviews");
  await mkdir(reviewsDirectory, { recursive: true });
  await copyFile(
    path.join(fixtureRoot, "reviews/batch-001.review.json"),
    path.join(reviewsDirectory, "batch-001.review.json"),
  );
  const secondReview = JSON.parse(
    await readFile(path.join(fixtureRoot, "reviews/batch-002.review.json"), "utf8"),
  );
  secondReview.decisions = secondReview.decisions.slice(0, 1);
  await writeFile(
    path.join(reviewsDirectory, "batch-002.review.json"),
    `${JSON.stringify(secondReview, null, 2)}\n`,
  );
  const result = await validateScreeningReviews({ root: temporaryRoot, runDirectory });
  assert.equal(result.discoveredCandidateCount, 4);
  assert.equal(result.candidateCount, 3);
  assert.equal(result.ledgerSkippedCandidateCount, 1);

  const bypassed = await prepareScreening({
    root: temporaryRoot,
    runDirectory,
    outputDirectory: path.join(runDirectory, "screening-bypass"),
    researchConfigFile: researchFile,
    venueRegistryFile: venueFile,
    decisionLedgerFile: ledgerFile,
    batchSize: 2,
    now: "2026-08-06T00:31:00.000Z",
    ignoreDecisionLedger: true,
  });
  assert.equal(bypassed.screeningManifest.counts.candidates, 4);
  assert.equal(bypassed.screeningManifest.counts.ledgerSkippedCandidates, 0);
  assert.equal(bypassed.ledgerSnapshot.override.ignoreDecisionLedger, true);

  const tamperedSnapshot = JSON.parse(await readFile(prepared.ledgerSnapshotFile, "utf8"));
  tamperedSnapshot.matches[0].sourceImport.delta.sha256 = "tampered-delta-hash";
  await writeFile(
    prepared.ledgerSnapshotFile,
    `${JSON.stringify(tamperedSnapshot, null, 2)}\n`,
  );
  const tamperedManifest = JSON.parse(
    await readFile(prepared.screeningManifestFile, "utf8"),
  );
  tamperedManifest.accounting.ledgerSkippedCandidates = tamperedSnapshot.matches;
  tamperedManifest.sourceInputs.decisionLedgerSnapshot.sha256 = sha256(
    await readFile(prepared.ledgerSnapshotFile),
  );
  await writeFile(
    prepared.screeningManifestFile,
    `${JSON.stringify(tamperedManifest, null, 2)}\n`,
  );
  await assert.rejects(
    () => validateScreeningReviews({ root: temporaryRoot, runDirectory }),
    /delta hash changed/,
  );

  const laterRunId = "verified-later-defer";
  const laterObservationBody = {
    ...observationBody,
    outcome: "defer",
    stage: "fulltext",
    skipMode: "non-terminal",
    runId: laterRunId,
    decidedAt: "2026-08-05T01:00:00.000Z",
    reasonCodes: ["needs-more-evidence"],
  };
  const laterObservation = {
    observationId: sha256Value(laterObservationBody),
    ...laterObservationBody,
  };
  const laterDelta = {
    schemaVersion: 1,
    kind: DECISION_LEDGER_DELTA_KIND,
    policyVersion: 1,
    runId: laterRunId,
    generatedAt: laterObservation.decidedAt,
    policy,
    observations: [laterObservation],
  };
  const laterDeltaFile = path.join(temporaryRoot, "later-delta.json");
  await writeFile(laterDeltaFile, `${JSON.stringify(laterDelta, null, 2)}\n`);
  const laterDeltaRecord = {
    file: path.relative(temporaryRoot, laterDeltaFile),
    sha256: sha256(await readFile(laterDeltaFile)),
  };
  const laterReceiptFile = path.join(temporaryRoot, "later-receipt.json");
  await writeFile(
    laterReceiptFile,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: "paper-reading-run-receipt",
        runId: laterRunId,
        status: "content-verified",
        decisionLedger: { delta: laterDeltaRecord },
      },
      null,
      2,
    )}\n`,
  );
  const ledgerWithDefer = mergeDecisionLedger({
    ledger: JSON.parse(await readFile(ledgerFile, "utf8")),
    delta: laterDelta,
    deltaArtifact: laterDeltaRecord,
    receiptArtifact: {
      file: path.relative(temporaryRoot, laterReceiptFile),
      sha256: sha256(await readFile(laterReceiptFile)),
    },
  });
  await writeFile(ledgerFile, `${JSON.stringify(ledgerWithDefer, null, 2)}\n`);

  const afterDefer = await prepareScreening({
    root: temporaryRoot,
    runDirectory,
    outputDirectory: path.join(runDirectory, "screening-after-defer"),
    researchConfigFile: researchFile,
    venueRegistryFile: venueFile,
    decisionLedgerFile: ledgerFile,
    batchSize: 2,
    now: "2026-08-06T00:32:00.000Z",
  });
  assert.equal(afterDefer.screeningManifest.counts.candidates, 4);
  assert.equal(afterDefer.screeningManifest.counts.ledgerSkippedCandidates, 0);
  assert.equal(
    afterDefer.ledgerSnapshot.misses.find(
      (entry) => entry.candidateId === skippedCandidate.discoveryId,
    )?.reason,
    "latest-explicit-review-is-non-reusable",
  );
  assert.equal(afterDefer.ledgerSnapshot.importProofs.length, 2);
  assert.equal(
    afterDefer.ledgerSnapshot.importProofs.every((proof) => proof.verified),
    true,
  );

  const unverifiedRunId = "unverified-later-terminal";
  const unverifiedObservationBody = {
    ...observationBody,
    outcome: "screening-reject",
    stage: "screening",
    skipMode: "terminal",
    runId: unverifiedRunId,
    decidedAt: "2026-08-05T02:00:00.000Z",
    reasonCodes: ["no-topic-fit"],
  };
  const unverifiedObservation = {
    observationId: sha256Value(unverifiedObservationBody),
    ...unverifiedObservationBody,
  };
  const unverifiedDelta = {
    schemaVersion: 1,
    kind: DECISION_LEDGER_DELTA_KIND,
    policyVersion: 1,
    runId: unverifiedRunId,
    generatedAt: unverifiedObservation.decidedAt,
    policy,
    observations: [unverifiedObservation],
  };
  const unverifiedDeltaFile = path.join(temporaryRoot, "unverified-delta.json");
  await writeFile(
    unverifiedDeltaFile,
    `${JSON.stringify(unverifiedDelta, null, 2)}\n`,
  );
  const unverifiedDeltaRecord = {
    file: path.relative(temporaryRoot, unverifiedDeltaFile),
    sha256: sha256(await readFile(unverifiedDeltaFile)),
  };
  const unverifiedReceiptFile = path.join(temporaryRoot, "unverified-receipt.json");
  await writeFile(
    unverifiedReceiptFile,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: "paper-reading-run-receipt",
        runId: unverifiedRunId,
        status: "content-verified",
        decisionLedger: { delta: unverifiedDeltaRecord },
      },
      null,
      2,
    )}\n`,
  );
  const ledgerWithUnverifiedTerminal = mergeDecisionLedger({
    ledger: ledgerWithDefer,
    delta: unverifiedDelta,
    deltaArtifact: unverifiedDeltaRecord,
    receiptArtifact: {
      file: path.relative(temporaryRoot, unverifiedReceiptFile),
      sha256: sha256(await readFile(unverifiedReceiptFile)),
    },
  });
  await writeFile(
    ledgerFile,
    `${JSON.stringify(ledgerWithUnverifiedTerminal, null, 2)}\n`,
  );
  await writeFile(
    unverifiedDeltaFile,
    `${await readFile(unverifiedDeltaFile, "utf8")}\n`,
  );

  const afterProofFailure = await prepareScreening({
    root: temporaryRoot,
    runDirectory,
    outputDirectory: path.join(runDirectory, "screening-after-proof-failure"),
    researchConfigFile: researchFile,
    venueRegistryFile: venueFile,
    decisionLedgerFile: ledgerFile,
    batchSize: 2,
    now: "2026-08-06T00:33:00.000Z",
  });
  assert.equal(afterProofFailure.screeningManifest.counts.candidates, 4);
  assert.equal(afterProofFailure.screeningManifest.counts.ledgerSkippedCandidates, 0);
  assert.equal(
    afterProofFailure.ledgerSnapshot.misses.find(
      (entry) => entry.candidateId === skippedCandidate.discoveryId,
    )?.reason,
    "decision-ledger-import-proof-failed",
  );
  assert.equal(
    afterProofFailure.ledgerSnapshot.importProofs.find(
      (proof) => proof.runId === unverifiedRunId,
    )?.verified,
    false,
  );
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
