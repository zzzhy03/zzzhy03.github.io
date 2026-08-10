import assert from "node:assert/strict";
import test from "node:test";

import {
  DECISION_LEDGER_DELTA_KIND,
  DECISION_LEDGER_SCHEMA_VERSION,
  buildExactDecisionIdentity,
  buildPolicyDescriptor,
  candidateEvidenceFingerprint,
  canonicalJson,
  emptyDecisionLedger,
  matchCandidateAgainstLedger,
  mergeDecisionLedger,
  sha256Value,
} from "../decision-ledger.mjs";

const REVIEW_CONTRACT = {
  schemaVersion: 1,
  kind: "paper-reading-screening-review-contract-test-fixture",
};

function candidate({
  id = "2608.12345",
  version = 1,
  abstract = "A stable abstract used by the decision-ledger fixture.",
  includeExplicitVersion = true,
} = {}) {
  const exactVersion = includeExplicitVersion ? `${id}v${version}` : id;
  return {
    discoveryId: `candidate:${id.replace(".", "-")}`,
    title: "An Exact-Version Decision Ledger Fixture",
    authors: ["Fixture Author"],
    publishedAt: "2026-08-07T00:00:00Z",
    updatedAt: "2026-08-07T00:00:00Z",
    abstract,
    categories: ["cs.CV"],
    primaryCategory: "cs.CV",
    identifiers: {
      arxiv: [id],
      doi: [],
      openReviewForum: [],
    },
    ...(includeExplicitVersion ? { arxivVersion: version } : {}),
    venueMatches: [],
    sourceNotes: { journalRef: null, comments: null },
    links: [
      {
        label: "Paper",
        href: `https://arxiv.org/abs/${exactVersion}`,
      },
    ],
    sourceRecords: [
      {
        source: "arxiv",
        sourceRecordId: exactVersion,
        url: `https://arxiv.org/abs/${exactVersion}`,
        publishedAt: "2026-08-07T00:00:00Z",
        updatedAt: "2026-08-07T00:00:00Z",
      },
    ],
  };
}

function policy({ researchConfigSha256 = "research-config-v1" } = {}) {
  return buildPolicyDescriptor({
    researchConfigSha256,
    researchConfigStatus: "active",
    venueRegistrySha256: "venue-registry-v1",
    venueRegistryStatus: "active",
    selectedTopicIds: ["3d-generation"],
    reviewContract: REVIEW_CONTRACT,
  });
}

function observation({
  sourceCandidate,
  sourcePolicy,
  outcome = "screening-reject",
  stage = "screening",
  skipMode = "terminal",
  runId = "run-screening-reject",
  decidedAt = "2026-08-07T01:00:00.000Z",
  manualOverride = false,
}) {
  const exact = buildExactDecisionIdentity(sourceCandidate);
  assert.ok(exact.identity, `fixture must have exact identity: ${exact.reason}`);
  const body = {
    artifactKey: exact.identity.artifactKey,
    paperId: exact.identity.paperId,
    exactVersion: exact.identity.exactVersion,
    identityStatus: "exact",
    candidateEvidenceFingerprint: candidateEvidenceFingerprint(sourceCandidate),
    policyFingerprint: sourcePolicy.fingerprint,
    outcome,
    stage,
    skipMode,
    runId,
    candidateId: sourceCandidate.discoveryId,
    title: sourceCandidate.title,
    decidedAt,
    reasonCodes:
      outcome === "administrative-already-canonical"
        ? ["already-canonical"]
        : [],
    revisit: {
      triggers: ["new-version", "evidence-change", "policy-change", "manual"],
    },
    artifacts: {
      screeningReview: null,
      fulltextReview: null,
      backlog: null,
    },
    ...(manualOverride ? { manualOverride: true } : {}),
  };
  return { observationId: sha256Value(body), ...body };
}

function delta({ runId, sourcePolicy, observations, generatedAt }) {
  const decisionLedgerBypassed = observations.some(
    (entry) => entry.manualOverride === true,
  );
  return {
    schemaVersion: DECISION_LEDGER_SCHEMA_VERSION,
    kind: DECISION_LEDGER_DELTA_KIND,
    policyVersion: 1,
    runId,
    generatedAt,
    policy: sourcePolicy,
    ...(decisionLedgerBypassed
      ? { override: { decisionLedgerBypassed: true } }
      : {}),
    observations,
  };
}

function mergeRun(ledger, runDelta) {
  return mergeDecisionLedger({
    ledger,
    delta: runDelta,
    deltaArtifact: {
      file: `content/paper-reading/ledger/${runDelta.runId}.delta.json`,
      sha256: `delta-${runDelta.runId}`,
    },
    receiptArtifact: {
      file: `content/paper-reading/runs/${runDelta.runId}.json`,
      sha256: `receipt-${runDelta.runId}`,
    },
  });
}

function ledgerWithObservation(entry, sourcePolicy) {
  const runDelta = delta({
    runId: entry.runId,
    sourcePolicy,
    observations: [entry],
    generatedAt: entry.decidedAt,
  });
  return mergeRun(emptyDecisionLedger(), runDelta);
}

test("an unchanged exact version reuses a receipt-backed terminal decision", () => {
  const sourceCandidate = candidate();
  const sourcePolicy = policy();
  const entry = observation({ sourceCandidate, sourcePolicy });
  const ledger = ledgerWithObservation(entry, sourcePolicy);

  const match = matchCandidateAgainstLedger({
    candidate: sourceCandidate,
    ledger,
    policy: sourcePolicy,
  });

  assert.equal(match.matched, true);
  assert.equal(match.reason, "receipt-backed-terminal-decision");
  assert.equal(match.identity.artifactKey, "arxiv:2608.12345@v1");
  assert.equal(match.observation.outcome, "screening-reject");
});

test("a new arXiv version does not reuse the previous exact-version decision", () => {
  const versionOne = candidate({ version: 1 });
  const versionTwo = candidate({ version: 2 });
  const sourcePolicy = policy();
  const ledger = ledgerWithObservation(
    observation({ sourceCandidate: versionOne, sourcePolicy }),
    sourcePolicy,
  );

  assert.equal(versionOne.discoveryId, versionTwo.discoveryId);
  const match = matchCandidateAgainstLedger({
    candidate: versionTwo,
    ledger,
    policy: sourcePolicy,
  });
  assert.equal(match.matched, false);
  assert.equal(match.reason, "no-exact-policy-evidence-match");
  assert.equal(match.identity.artifactKey, "arxiv:2608.12345@v2");
});

test("a candidate without an explicit source version is never reusable", () => {
  const sourcePolicy = policy();
  const versionedCandidate = candidate();
  const ledger = ledgerWithObservation(
    observation({ sourceCandidate: versionedCandidate, sourcePolicy }),
    sourcePolicy,
  );
  const versionlessCandidate = candidate({ includeExplicitVersion: false });

  const match = matchCandidateAgainstLedger({
    candidate: versionlessCandidate,
    ledger,
    policy: sourcePolicy,
  });
  assert.equal(match.matched, false);
  assert.equal(match.reason, "missing-exact-version");
  assert.equal(match.identity, null);
});

test("evidence or policy changes invalidate an otherwise exact-version match", () => {
  const sourceCandidate = candidate();
  const sourcePolicy = policy();
  const ledger = ledgerWithObservation(
    observation({ sourceCandidate, sourcePolicy }),
    sourcePolicy,
  );

  const changedEvidence = matchCandidateAgainstLedger({
    candidate: candidate({ abstract: "The abstract changed while the version stayed fixed." }),
    ledger,
    policy: sourcePolicy,
  });
  assert.equal(changedEvidence.matched, false);
  assert.equal(changedEvidence.reason, "no-exact-policy-evidence-match");

  const changedPolicy = matchCandidateAgainstLedger({
    candidate: sourceCandidate,
    ledger,
    policy: policy({ researchConfigSha256: "research-config-v2" }),
  });
  assert.equal(changedPolicy.matched, false);
  assert.equal(changedPolicy.reason, "no-exact-policy-evidence-match");
});

test("defer, backlog, and manual-review observations remain non-reusable", () => {
  const sourceCandidate = candidate();
  const sourcePolicy = policy();
  const cases = [
    { outcome: "defer", stage: "fulltext" },
    { outcome: "administrative-backlog", stage: "administrative" },
    { outcome: "manual-review", stage: "screening" },
  ];

  for (const [index, fixture] of cases.entries()) {
    const entry = observation({
      sourceCandidate,
      sourcePolicy,
      ...fixture,
      skipMode: "non-terminal",
      runId: `run-non-terminal-${index}`,
    });
    const ledger = ledgerWithObservation(entry, sourcePolicy);
    const match = matchCandidateAgainstLedger({
      candidate: sourceCandidate,
      ledger,
      policy: sourcePolicy,
    });
    assert.equal(match.matched, false, fixture.outcome);
    assert.equal(match.reason, "latest-explicit-review-is-non-reusable", fixture.outcome);
  }
});

test("an accepted observation requires the same exact version in canonical content", () => {
  const sourceCandidate = candidate();
  const sourcePolicy = policy();
  const entry = observation({
    sourceCandidate,
    sourcePolicy,
    outcome: "accepted-deep",
    stage: "fulltext",
    runId: "run-accepted",
  });
  const ledger = ledgerWithObservation(entry, sourcePolicy);

  const missingExactCanonical = matchCandidateAgainstLedger({
    candidate: sourceCandidate,
    ledger,
    policy: sourcePolicy,
    canonicalExactVersions: new Map([
      [entry.paperId, new Set(["arxiv:2608.12345@v2"])],
    ]),
  });
  assert.equal(missingExactCanonical.matched, false);
  assert.equal(missingExactCanonical.reason, "canonical-exact-version-is-missing");

  const exactCanonical = matchCandidateAgainstLedger({
    candidate: sourceCandidate,
    ledger,
    policy: sourcePolicy,
    canonicalExactVersions: new Map([[entry.paperId, new Set([entry.artifactKey])]]),
  });
  assert.equal(exactCanonical.matched, true);
  assert.equal(exactCanonical.observation.outcome, "accepted-deep");
});

test("merge is idempotent and a later administrative marker does not replace a substantive decision", () => {
  const sourceCandidate = candidate();
  const sourcePolicy = policy();
  const fulltext = observation({
    sourceCandidate,
    sourcePolicy,
    outcome: "accepted-skim",
    stage: "fulltext",
    runId: "run-fulltext",
    decidedAt: "2026-08-07T01:00:00.000Z",
  });
  const administrative = observation({
    sourceCandidate,
    sourcePolicy,
    outcome: "administrative-already-canonical",
    stage: "administrative",
    runId: "run-administrative",
    decidedAt: "2026-08-08T01:00:00.000Z",
  });
  const fulltextDelta = delta({
    runId: fulltext.runId,
    sourcePolicy,
    observations: [fulltext],
    generatedAt: fulltext.decidedAt,
  });
  const administrativeDelta = delta({
    runId: administrative.runId,
    sourcePolicy,
    observations: [administrative],
    generatedAt: administrative.decidedAt,
  });

  const afterFulltext = mergeRun(emptyDecisionLedger(), fulltextDelta);
  const repeatedFulltext = mergeRun(afterFulltext, fulltextDelta);
  assert.equal(canonicalJson(repeatedFulltext), canonicalJson(afterFulltext));

  const combined = mergeRun(repeatedFulltext, administrativeDelta);
  const repeatedCombined = mergeRun(combined, administrativeDelta);
  assert.equal(canonicalJson(repeatedCombined), canonicalJson(combined));
  assert.equal(combined.summary.observations, 2);
  assert.deepEqual(combined.summary.effectiveOutcomes, { "accepted-skim": 1 });

  const match = matchCandidateAgainstLedger({
    candidate: sourceCandidate,
    ledger: combined,
    policy: sourcePolicy,
    canonicalExactVersions: new Map([
      [fulltext.paperId, new Set([fulltext.artifactKey])],
    ]),
  });
  assert.equal(match.matched, true);
  assert.equal(match.observation.observationId, fulltext.observationId);
  assert.equal(match.observation.outcome, "accepted-skim");
});

test("summary keeps different evidence and policy contexts separate", () => {
  const sourceCandidate = candidate();
  const originalPolicy = policy();
  const changedPolicy = policy({ researchConfigSha256: "research-config-v2" });
  const original = observation({
    sourceCandidate,
    sourcePolicy: originalPolicy,
    outcome: "screening-reject",
    stage: "screening",
    runId: "run-original-policy",
    decidedAt: "2026-08-07T01:00:00.000Z",
  });
  const changed = observation({
    sourceCandidate,
    sourcePolicy: changedPolicy,
    outcome: "accepted-skim",
    stage: "fulltext",
    runId: "run-changed-policy",
    decidedAt: "2026-08-08T01:00:00.000Z",
  });
  let ledger = mergeRun(
    emptyDecisionLedger(),
    delta({
      runId: original.runId,
      sourcePolicy: originalPolicy,
      observations: [original],
      generatedAt: original.decidedAt,
    }),
  );
  ledger = mergeRun(
    ledger,
    delta({
      runId: changed.runId,
      sourcePolicy: changedPolicy,
      observations: [changed],
      generatedAt: changed.decidedAt,
    }),
  );

  assert.equal(ledger.summary.decisionContexts, 2);
  assert.deepEqual(ledger.summary.effectiveOutcomes, {
    "accepted-skim": 1,
    "screening-reject": 1,
  });
});

test("an explicit bypass supersedes old decisions and later reviews can converge", () => {
  const sourceCandidate = candidate();
  const sourcePolicy = policy();
  const oldAccept = observation({
    sourceCandidate,
    sourcePolicy,
    outcome: "accepted-deep",
    stage: "fulltext",
    runId: "run-old-accept",
    decidedAt: "2026-08-07T01:00:00.000Z",
  });
  const explicitDefer = observation({
    sourceCandidate,
    sourcePolicy,
    outcome: "defer",
    stage: "fulltext",
    skipMode: "non-terminal",
    runId: "run-explicit-defer",
    decidedAt: "2026-08-08T01:00:00.000Z",
    manualOverride: true,
  });
  const laterReject = observation({
    sourceCandidate,
    sourcePolicy,
    outcome: "screening-reject",
    stage: "screening",
    runId: "run-later-reject",
    decidedAt: "2026-08-09T01:00:00.000Z",
  });
  let ledger = mergeRun(
    emptyDecisionLedger(),
    delta({
      runId: oldAccept.runId,
      sourcePolicy,
      observations: [oldAccept],
      generatedAt: oldAccept.decidedAt,
    }),
  );
  ledger = mergeRun(
    ledger,
    delta({
      runId: explicitDefer.runId,
      sourcePolicy,
      observations: [explicitDefer],
      generatedAt: explicitDefer.decidedAt,
    }),
  );
  const deferred = matchCandidateAgainstLedger({
    candidate: sourceCandidate,
    ledger,
    policy: sourcePolicy,
    canonicalExactVersions: new Map([
      [oldAccept.paperId, new Set([oldAccept.artifactKey])],
    ]),
  });
  assert.equal(deferred.matched, false);
  assert.equal(deferred.reason, "latest-explicit-review-is-non-reusable");

  ledger = mergeRun(
    ledger,
    delta({
      runId: laterReject.runId,
      sourcePolicy,
      observations: [laterReject],
      generatedAt: laterReject.decidedAt,
    }),
  );
  const resolved = matchCandidateAgainstLedger({
    candidate: sourceCandidate,
    ledger,
    policy: sourcePolicy,
  });
  assert.equal(resolved.matched, true);
  assert.equal(resolved.observation.outcome, "screening-reject");
});
