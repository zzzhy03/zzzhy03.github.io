import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

import { parseArxivIdentifier } from "./lib/identity.mjs";

export const DECISION_LEDGER_SCHEMA_VERSION = 1;
export const DECISION_LEDGER_POLICY_VERSION = 1;
export const DECISION_LEDGER_FULLTEXT_SCHEMA_VERSION = 2;
export const DECISION_LEDGER_KIND = "paper-reading-decision-ledger";
export const DECISION_LEDGER_DELTA_KIND = "paper-reading-decision-ledger-delta";
export const DECISION_LEDGER_SNAPSHOT_KIND =
  "paper-reading-decision-ledger-input-snapshot";
export const DEFAULT_DECISION_LEDGER_FILE = path.join(
  "content",
  "paper-reading",
  "state",
  "decision-ledger.json",
);
export const LEGACY_DECISION_LEDGER_RUN_IDS = new Set([
  "live-dry-run-20260806-v2",
  "paper-reading-20260807-094202",
]);

const OUTCOMES = new Set([
  "screening-reject",
  "accepted-deep",
  "accepted-skim",
  "fulltext-reject",
  "defer",
  "manual-review",
  "administrative-backlog",
  "administrative-already-canonical",
  "abstract-accept-pending-promotion",
]);

const TERMINAL_OUTCOMES = new Set([
  "screening-reject",
  "accepted-deep",
  "accepted-skim",
  "fulltext-reject",
  "administrative-already-canonical",
]);

const CANONICAL_REQUIRED_OUTCOMES = new Set([
  "accepted-deep",
  "accepted-skim",
  "administrative-already-canonical",
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Value(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function sha256FileSync(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function parsedArxivFromSourceRecord(sourceRecord) {
  if (sourceRecord?.source !== "arxiv") return { parsed: null, error: null };
  const fromId = parseArxivIdentifier(sourceRecord.sourceRecordId);
  const fromUrl = parseArxivIdentifier(sourceRecord.url);
  if (
    fromId &&
    fromUrl &&
    (fromId.id !== fromUrl.id || fromId.version !== fromUrl.version)
  ) {
    return {
      parsed: null,
      error: "arXiv sourceRecordId and URL identify different exact versions",
    };
  }
  return { parsed: fromId ?? fromUrl, error: null };
}

export function buildExactDecisionKeys(candidate) {
  const keys = [];
  const errors = [];
  for (const sourceRecord of candidate?.sourceRecords ?? []) {
    const result = parsedArxivFromSourceRecord(sourceRecord);
    if (result.error) errors.push(result.error);
    if (!result.parsed?.version) continue;
    keys.push({
      source: "arxiv",
      paperId: `arxiv:${result.parsed.id}`,
      exactVersion: `${result.parsed.id}v${result.parsed.version}`,
      artifactKey: `arxiv:${result.parsed.id}@v${result.parsed.version}`,
    });
  }
  const byArtifactKey = new Map(keys.map((key) => [key.artifactKey, key]));
  return {
    keys: [...byArtifactKey.values()].sort((left, right) =>
      left.artifactKey.localeCompare(right.artifactKey),
    ),
    errors: uniqueSorted(errors),
  };
}

export function buildExactDecisionIdentity(candidate) {
  const { keys, errors } = buildExactDecisionKeys(candidate);
  if (errors.length) return { identity: null, reason: "inconsistent-source-record", errors };
  if (keys.length !== 1) {
    return {
      identity: null,
      reason: keys.length ? "ambiguous-exact-version" : "missing-exact-version",
      errors: [],
    };
  }
  const identity = keys[0];
  const recordedArxivIds = uniqueSorted(candidate?.identifiers?.arxiv ?? []);
  if (
    recordedArxivIds.length !== 1 ||
    `arxiv:${recordedArxivIds[0]}` !== identity.paperId
  ) {
    return {
      identity: null,
      reason: "inconsistent-versionless-identifier",
      errors: [],
    };
  }
  const parsed = parseArxivIdentifier(identity.exactVersion);
  if (
    Number.isInteger(candidate?.arxivVersion) &&
    candidate.arxivVersion > 0 &&
    candidate.arxivVersion !== parsed?.version
  ) {
    return {
      identity: null,
      reason: "inconsistent-group-version",
      errors: [],
    };
  }
  return { identity, reason: null, errors: [] };
}

function stableAuthor(author) {
  if (typeof author === "string") return author;
  if (!author || typeof author !== "object") return String(author ?? "");
  return {
    name: author.name ?? null,
    given: author.given ?? null,
    family: author.family ?? null,
  };
}

function stableSourceRecord(record) {
  return {
    source: record.source ?? null,
    sourceRecordId: record.sourceRecordId ?? null,
    url: record.url ?? null,
    publishedAt: record.publishedAt ?? null,
    updatedAt: record.updatedAt ?? null,
  };
}

export function candidateEvidenceProjection(candidate) {
  const { keys } = buildExactDecisionKeys(candidate);
  return {
    exactArtifactKeys: keys.map((key) => key.artifactKey),
    title: candidate?.title ?? null,
    authors: (candidate?.authors ?? []).map(stableAuthor),
    abstract: candidate?.abstract ?? null,
    categories: uniqueSorted(candidate?.categories ?? []),
    primaryCategory: candidate?.primaryCategory ?? null,
    publishedAt: candidate?.publishedAt ?? null,
    updatedAt: candidate?.updatedAt ?? null,
    identifiers: {
      arxiv: uniqueSorted(candidate?.identifiers?.arxiv ?? []),
      doi: uniqueSorted(candidate?.identifiers?.doi ?? []),
      openReviewForum: uniqueSorted(candidate?.identifiers?.openReviewForum ?? []),
    },
    venueText: candidate?.venueText ?? null,
    venueMatches: [...(candidate?.venueMatches ?? [])]
      .map((match) => ({ id: match.id ?? null, evidence: match.evidence ?? null }))
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
    sourceNotes: candidate?.sourceNotes ?? null,
    links: [...(candidate?.links ?? [])]
      .map((link) => ({ label: link.label ?? null, href: link.href ?? null }))
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
    sourceRecords: [...(candidate?.sourceRecords ?? [])]
      .map(stableSourceRecord)
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
  };
}

export function candidateEvidenceFingerprint(candidate) {
  return sha256Value(candidateEvidenceProjection(candidate));
}

export function buildPolicyDescriptor({
  researchConfigSha256,
  researchConfigStatus,
  venueRegistrySha256,
  venueRegistryStatus,
  selectedTopicIds = [],
  reviewContract,
  fulltextSchemaVersion = DECISION_LEDGER_FULLTEXT_SCHEMA_VERSION,
}) {
  if (!researchConfigSha256 || !venueRegistrySha256 || !reviewContract) {
    throw new Error(
      "Decision-ledger policy requires research config, venue registry and review contract hashes.",
    );
  }
  const descriptor = {
    policyVersion: DECISION_LEDGER_POLICY_VERSION,
    researchConfigSha256,
    researchConfigStatus: researchConfigStatus ?? null,
    venueRegistrySha256,
    venueRegistryStatus: venueRegistryStatus ?? null,
    selectedTopicIds: uniqueSorted(selectedTopicIds),
    screeningContractSha256: sha256Value(reviewContract),
    screeningSchemaVersion: reviewContract.schemaVersion ?? null,
    fulltextSchemaVersion,
  };
  return {
    ...descriptor,
    active:
      descriptor.researchConfigStatus === "active" &&
      descriptor.venueRegistryStatus === "active",
    fingerprint: sha256Value(descriptor),
  };
}

export function validatePolicyDescriptor(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("Decision-ledger policy descriptor must be an object.");
  }
  const { fingerprint, active, ...descriptor } = policy;
  if (fingerprint !== sha256Value(descriptor)) {
    throw new Error("Decision-ledger policy fingerprint does not match its descriptor.");
  }
  const expectedActive =
    descriptor.researchConfigStatus === "active" &&
    descriptor.venueRegistryStatus === "active";
  if (active !== expectedActive) {
    throw new Error("Decision-ledger policy active flag is inconsistent.");
  }
  return policy;
}

export function buildRunPolicyDescriptor(discoveryManifest, screeningManifest) {
  return buildPolicyDescriptor({
    researchConfigSha256: screeningManifest?.sourceInputs?.researchConfig?.sha256,
    researchConfigStatus:
      screeningManifest?.sourceInputs?.researchConfig?.status ??
      discoveryManifest?.configuration?.researchConfigStatus,
    venueRegistrySha256: screeningManifest?.sourceInputs?.venueRegistry?.sha256,
    venueRegistryStatus:
      screeningManifest?.sourceInputs?.venueRegistry?.status ??
      discoveryManifest?.configuration?.venueRegistryStatus,
    selectedTopicIds: discoveryManifest?.configuration?.selectedTopicIds ?? [],
    reviewContract: screeningManifest?.reviewContract,
  });
}

export function emptyDecisionLedger() {
  return {
    schemaVersion: DECISION_LEDGER_SCHEMA_VERSION,
    kind: DECISION_LEDGER_KIND,
    policyVersion: DECISION_LEDGER_POLICY_VERSION,
    generatedAt: null,
    imports: [],
    observations: [],
    summary: {
      papers: 0,
      exactVersions: 0,
      policies: 0,
      observations: 0,
      terminalObservations: 0,
      decisionContexts: 0,
      effectiveOutcomes: {},
    },
  };
}

export function validateDecisionLedger(ledger) {
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    throw new Error("Decision ledger must be an object.");
  }
  if (ledger.schemaVersion !== DECISION_LEDGER_SCHEMA_VERSION) {
    throw new Error(
      `Decision ledger schemaVersion must be ${DECISION_LEDGER_SCHEMA_VERSION}.`,
    );
  }
  if (ledger.kind !== DECISION_LEDGER_KIND) {
    throw new Error(`Decision ledger kind must be '${DECISION_LEDGER_KIND}'.`);
  }
  if (!Array.isArray(ledger.imports) || !Array.isArray(ledger.observations)) {
    throw new Error("Decision ledger imports and observations must be arrays.");
  }
  const observationIds = new Set();
  for (const observation of ledger.observations) {
    if (!observation?.observationId || observationIds.has(observation.observationId)) {
      throw new Error("Decision ledger observationId values must be unique and non-empty.");
    }
    observationIds.add(observation.observationId);
    const { observationId, ...observationBody } = observation;
    if (observationId !== sha256Value(observationBody)) {
      throw new Error(`Observation '${observationId}' content hash is invalid.`);
    }
    if (!OUTCOMES.has(observation.outcome)) {
      throw new Error(`Unknown decision-ledger outcome '${observation.outcome}'.`);
    }
    if (!new Set(["terminal", "non-terminal"]).has(observation.skipMode)) {
      throw new Error(`Observation '${observation.observationId}' has invalid skipMode.`);
    }
    if (observation.skipMode === "terminal" && !TERMINAL_OUTCOMES.has(observation.outcome)) {
      throw new Error(
        `Observation '${observation.observationId}' cannot make '${observation.outcome}' terminal.`,
      );
    }
  }
  const runIds = new Set();
  for (const imported of ledger.imports) {
    if (!imported?.runId || runIds.has(imported.runId)) {
      throw new Error("Decision ledger imports must have unique non-empty runId values.");
    }
    runIds.add(imported.runId);
    if (
      typeof imported.delta?.file !== "string" ||
      typeof imported.delta?.sha256 !== "string" ||
      typeof imported.receipt?.file !== "string" ||
      typeof imported.receipt?.sha256 !== "string"
    ) {
      throw new Error(`Decision ledger import '${imported.runId}' lacks hashed artifacts.`);
    }
    if (!Number.isInteger(imported.observationCount) || imported.observationCount < 0) {
      throw new Error(`Decision ledger import '${imported.runId}' has invalid observationCount.`);
    }
  }
  for (const observation of ledger.observations) {
    if (!runIds.has(observation.runId)) {
      throw new Error(
        `Observation '${observation.observationId}' is not backed by an imported run.`,
      );
    }
  }
  for (const imported of ledger.imports) {
    const importedObservations = ledger.observations.filter(
      (observation) => observation.runId === imported.runId,
    );
    if (importedObservations.length !== imported.observationCount) {
      throw new Error(
        `Decision ledger import '${imported.runId}' observation count is inconsistent.`,
      );
    }
    if (
      importedObservations.some(
        (observation) => observation.policyFingerprint !== imported.policyFingerprint,
      )
    ) {
      throw new Error(
        `Decision ledger import '${imported.runId}' contains another policy fingerprint.`,
      );
    }
  }
  if (canonicalJson(ledger.summary) !== canonicalJson(summarizeLedger(ledger.observations))) {
    throw new Error("Decision ledger summary is inconsistent with observations.");
  }
  return ledger;
}

export function readDecisionLedgerSync(file) {
  if (!existsSync(file)) return emptyDecisionLedger();
  return validateDecisionLedger(JSON.parse(readFileSync(file, "utf8")));
}

export function buildCanonicalExactVersionIndex(paperDirectory) {
  const index = new Map();
  if (!existsSync(paperDirectory)) return index;
  for (const entry of readdirSync(paperDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const paper = JSON.parse(readFileSync(path.join(paperDirectory, entry.name), "utf8"));
    const keys = new Set();
    for (const link of paper.links ?? []) {
      const parsed = parseArxivIdentifier(link?.href);
      if (parsed?.version) keys.add(`arxiv:${parsed.id}@v${parsed.version}`);
    }
    index.set(paper.id, keys);
  }
  return index;
}

function canonicalStillExists(observation, canonicalExactVersions) {
  if (!CANONICAL_REQUIRED_OUTCOMES.has(observation.outcome)) return true;
  if (!observation.paperId) return false;
  return canonicalExactVersions
    ?.get(observation.paperId)
    ?.has(observation.artifactKey) ?? false;
}

function strongestObservations(observations) {
  if (!observations.length) return { observation: null, conflict: false };
  const withTimes = observations.map((observation) => ({
    observation,
    time: Date.parse(observation.decidedAt),
  }));
  if (withTimes.some((entry) => Number.isNaN(entry.time))) {
    return { observation: null, conflict: true };
  }
  const manualOverrides = observations.filter(
    (observation) => observation.manualOverride === true,
  );
  let considered = withTimes;
  if (manualOverrides.length) {
    const cutoff = Math.max(
      ...manualOverrides.map((observation) => Date.parse(observation.decidedAt)),
    );
    considered = withTimes.filter((entry) => entry.time >= cutoff);
  }
  const substantive = considered.filter(
    (entry) => entry.observation.outcome !== "administrative-already-canonical",
  );
  if (substantive.length) considered = substantive;
  const latestTime = Math.max(...considered.map((entry) => entry.time));
  const latest = considered
    .filter((entry) => entry.time === latestTime)
    .map((entry) => entry.observation);
  const outcomes = new Set(latest.map((observation) => observation.outcome));
  if (outcomes.size !== 1) return { observation: null, conflict: true };
  latest.sort((left, right) => right.observationId.localeCompare(left.observationId));
  return { observation: latest[0], conflict: false };
}

export function matchCandidateAgainstLedger({
  candidate,
  ledger,
  policy,
  canonicalExactVersions = new Map(),
}) {
  const exact = buildExactDecisionIdentity(candidate);
  const evidenceFingerprint = candidateEvidenceFingerprint(candidate);
  if (!exact.identity) {
    return {
      matched: false,
      reason: exact.reason,
      evidenceFingerprint,
      identity: null,
    };
  }
  if (!policy?.active) {
    return {
      matched: false,
      reason: "policy-not-active",
      evidenceFingerprint,
      identity: exact.identity,
    };
  }
  const candidates = ledger.observations.filter(
    (observation) =>
      observation.artifactKey === exact.identity.artifactKey &&
      observation.candidateEvidenceFingerprint === evidenceFingerprint &&
      observation.policyFingerprint === policy.fingerprint,
  );
  const resolved = strongestObservations(candidates);
  if (resolved.conflict) {
    return {
      matched: false,
      reason: "conflicting-latest-observations",
      evidenceFingerprint,
      identity: exact.identity,
    };
  }
  if (!resolved.observation) {
    return {
      matched: false,
      reason: "no-exact-policy-evidence-match",
      evidenceFingerprint,
      identity: exact.identity,
    };
  }
  if (resolved.observation.skipMode !== "terminal") {
    return {
      matched: false,
      reason: "latest-explicit-review-is-non-reusable",
      evidenceFingerprint,
      identity: exact.identity,
    };
  }
  if (!canonicalStillExists(resolved.observation, canonicalExactVersions)) {
    return {
      matched: false,
      reason: "canonical-exact-version-is-missing",
      evidenceFingerprint,
      identity: exact.identity,
    };
  }
  return {
    matched: true,
    reason: "receipt-backed-terminal-decision",
    evidenceFingerprint,
    identity: exact.identity,
    observation: resolved.observation,
  };
}

function listJsonFiles(directory, predicate = () => true) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && predicate(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function displayPath(root, file) {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : file;
}

function artifact(root, file) {
  return { file: displayPath(root, file), sha256: sha256FileSync(file) };
}

function decisionOutcome({ screeningDecision, fulltextReview, backlogged }) {
  if (screeningDecision.decision === "reject") {
    if (screeningDecision.reasonCodes?.includes("already-canonical")) {
      return {
        outcome: "administrative-already-canonical",
        stage: "administrative",
      };
    }
    return { outcome: "screening-reject", stage: "screening" };
  }
  if (screeningDecision.decision === "manual-review") {
    return { outcome: "manual-review", stage: "screening" };
  }
  if (screeningDecision.decision === "accept-from-abstract") {
    return { outcome: "abstract-accept-pending-promotion", stage: "screening" };
  }
  if (screeningDecision.decision !== "full-text-review") {
    throw new Error(`Unknown screening decision '${screeningDecision.decision}'.`);
  }
  if (fulltextReview) {
    const outcomes = {
      "accept-deep": "accepted-deep",
      "accept-skim": "accepted-skim",
      reject: "fulltext-reject",
      defer: "defer",
    };
    const outcome = outcomes[fulltextReview.decision];
    if (!outcome) throw new Error(`Unknown full-text decision '${fulltextReview.decision}'.`);
    return { outcome, stage: "fulltext" };
  }
  if (backlogged) return { outcome: "administrative-backlog", stage: "administrative" };
  throw new Error(
    `Candidate '${screeningDecision.candidateId}' requests full text but has no review or backlog record.`,
  );
}

function revisitPolicy(outcome) {
  if (outcome === "defer") {
    return { triggers: ["new-version", "evidence-change", "policy-change", "manual"] };
  }
  if (new Set([
    "manual-review",
    "administrative-backlog",
    "abstract-accept-pending-promotion",
  ]).has(outcome)) {
    return { triggers: ["next-run", "new-version", "policy-change", "manual"] };
  }
  return { triggers: ["new-version", "evidence-change", "policy-change", "manual"] };
}

export function buildDecisionLedgerDelta({ root, runDirectory }) {
  const candidateFile = path.join(runDirectory, "candidates.json");
  const discoveryManifestFile = path.join(runDirectory, "manifest.json");
  const screeningManifestFile = path.join(
    runDirectory,
    "screening",
    "screening-manifest.json",
  );
  const candidatePayload = JSON.parse(readFileSync(candidateFile, "utf8"));
  const discoveryManifest = JSON.parse(readFileSync(discoveryManifestFile, "utf8"));
  const screeningManifest = JSON.parse(readFileSync(screeningManifestFile, "utf8"));
  const policy = screeningManifest.accounting?.policyDescriptor
    ? validatePolicyDescriptor(screeningManifest.accounting.policyDescriptor)
    : buildRunPolicyDescriptor(discoveryManifest, screeningManifest);
  const screeningByCandidate = new Map();
  for (const file of listJsonFiles(
    path.join(runDirectory, "screening", "reviews"),
    (name) => name.endsWith(".review.json"),
  )) {
    const review = JSON.parse(readFileSync(file, "utf8"));
    for (const decision of review.decisions ?? []) {
      if (screeningByCandidate.has(decision.candidateId)) {
        throw new Error(`Duplicate screening decision for '${decision.candidateId}'.`);
      }
      screeningByCandidate.set(decision.candidateId, {
        decision,
        reviewedAt: review.reviewedAt,
        artifact: artifact(root, file),
      });
    }
  }
  const fulltextByCandidate = new Map();
  for (const file of listJsonFiles(
    path.join(runDirectory, "fulltext", "reviews"),
    (name) => name !== "summary.json",
  )) {
    const review = JSON.parse(readFileSync(file, "utf8"));
    if (fulltextByCandidate.has(review.candidateId)) {
      throw new Error(`Duplicate full-text review for '${review.candidateId}'.`);
    }
    fulltextByCandidate.set(review.candidateId, {
      review,
      artifact: artifact(root, file),
    });
  }
  const backlogFile = path.join(runDirectory, "fulltext", "backlog.json");
  const backlog = existsSync(backlogFile)
    ? JSON.parse(readFileSync(backlogFile, "utf8"))
    : { candidateIds: [] };
  const backlogIds = new Set(backlog.candidateIds ?? []);
  const backlogArtifact = existsSync(backlogFile) ? artifact(root, backlogFile) : null;
  const ledgerSkippedIds = new Set(
    (screeningManifest.accounting?.ledgerSkippedCandidates ?? []).map(
      (entry) => entry.candidateId,
    ),
  );
  const manualOverride = Boolean(
    screeningManifest.accounting?.decisionLedgerBypassed,
  );
  const observations = [];

  for (const candidate of candidatePayload.candidates ?? []) {
    if (ledgerSkippedIds.has(candidate.discoveryId)) continue;
    const screening = screeningByCandidate.get(candidate.discoveryId);
    if (!screening) {
      throw new Error(`Candidate '${candidate.discoveryId}' has no screening decision.`);
    }
    const fulltext = fulltextByCandidate.get(candidate.discoveryId);
    const resolved = decisionOutcome({
      screeningDecision: screening.decision,
      fulltextReview: fulltext?.review,
      backlogged: backlogIds.has(candidate.discoveryId),
    });
    const exact = buildExactDecisionIdentity(candidate);
    const evidenceFingerprint = candidateEvidenceFingerprint(candidate);
    const decidedAt =
      fulltext?.review.reviewedAt ??
      (backlogIds.has(candidate.discoveryId) ? backlog.generatedAt : null) ??
      screening.reviewedAt ??
      discoveryManifest.generatedAt ??
      null;
    const paperId =
      fulltext?.review.paperId ??
      (resolved.outcome === "administrative-already-canonical"
        ? candidate.existingMatch?.paperId ?? null
        : exact.identity?.paperId ?? null);
    const artifacts = {
      screeningReview: screening.artifact,
      fulltextReview: fulltext?.artifact ?? null,
      backlog: backlogIds.has(candidate.discoveryId) ? backlogArtifact : null,
    };
    const observationBody = {
      artifactKey: exact.identity?.artifactKey ?? null,
      paperId,
      exactVersion: exact.identity?.exactVersion ?? null,
      identityStatus: exact.identity ? "exact" : exact.reason,
      candidateEvidenceFingerprint: evidenceFingerprint,
      policyFingerprint: policy.fingerprint,
      outcome: resolved.outcome,
      stage: resolved.stage,
      skipMode:
        exact.identity && TERMINAL_OUTCOMES.has(resolved.outcome)
          ? "terminal"
          : "non-terminal",
      runId: candidatePayload.runId,
      candidateId: candidate.discoveryId,
      title: candidate.title,
      decidedAt,
      reasonCodes: screening.decision.reasonCodes ?? [],
      revisit: revisitPolicy(resolved.outcome),
      artifacts,
      ...(manualOverride ? { manualOverride: true } : {}),
    };
    observations.push({
      observationId: sha256Value(observationBody),
      ...observationBody,
    });
  }

  observations.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  const generatedAt = observations
    .map((observation) => observation.decidedAt)
    .filter(Boolean)
    .sort()
    .at(-1) ?? discoveryManifest.generatedAt ?? candidatePayload.generatedAt ?? null;
  const outcomes = {};
  for (const observation of observations) {
    outcomes[observation.outcome] = (outcomes[observation.outcome] ?? 0) + 1;
  }
  return {
    schemaVersion: DECISION_LEDGER_SCHEMA_VERSION,
    kind: DECISION_LEDGER_DELTA_KIND,
    policyVersion: DECISION_LEDGER_POLICY_VERSION,
    runId: candidatePayload.runId,
    generatedAt,
    policy,
    ...(manualOverride
      ? { override: { decisionLedgerBypassed: true } }
      : {}),
    sourceArtifacts: {
      candidates: artifact(root, candidateFile),
      discoveryManifest: artifact(root, discoveryManifestFile),
      screeningManifest: artifact(root, screeningManifestFile),
    },
    counts: {
      discoveredCandidates: candidatePayload.candidates?.length ?? 0,
      ledgerSkippedCandidates: ledgerSkippedIds.size,
      observations: observations.length,
      terminal: observations.filter((observation) => observation.skipMode === "terminal")
        .length,
      nonTerminal: observations.filter(
        (observation) => observation.skipMode === "non-terminal",
      ).length,
      outcomes,
    },
    observations,
  };
}

export function validateDecisionLedgerDelta(delta) {
  if (delta?.schemaVersion !== DECISION_LEDGER_SCHEMA_VERSION) {
    throw new Error(
      `Decision-ledger delta schemaVersion must be ${DECISION_LEDGER_SCHEMA_VERSION}.`,
    );
  }
  if (delta.kind !== DECISION_LEDGER_DELTA_KIND || !delta.runId) {
    throw new Error("Decision-ledger delta kind/runId is invalid.");
  }
  if (!Array.isArray(delta.observations)) {
    throw new Error("Decision-ledger delta observations must be an array.");
  }
  validatePolicyDescriptor(delta.policy);
  const observationIds = new Set();
  for (const observation of delta.observations) {
    if (observation.runId !== delta.runId) {
      throw new Error("Decision-ledger delta contains an observation from another run.");
    }
    if (!OUTCOMES.has(observation.outcome)) {
      throw new Error(`Unknown decision-ledger outcome '${observation.outcome}'.`);
    }
    if (!observation.observationId || observationIds.has(observation.observationId)) {
      throw new Error("Decision-ledger delta observation IDs must be unique and non-empty.");
    }
    observationIds.add(observation.observationId);
    const { observationId, ...observationBody } = observation;
    if (observationId !== sha256Value(observationBody)) {
      throw new Error(`Delta observation '${observationId}' content hash is invalid.`);
    }
    if (observation.policyFingerprint !== delta.policy.fingerprint) {
      throw new Error(
        `Delta observation '${observationId}' has another policy fingerprint.`,
      );
    }
    if (
      Boolean(observation.manualOverride) !==
      Boolean(delta.override?.decisionLedgerBypassed)
    ) {
      throw new Error(
        `Delta observation '${observationId}' has inconsistent manual override state.`,
      );
    }
  }
  if (
    delta.counts?.observations !== undefined &&
    delta.counts.observations !== delta.observations.length
  ) {
    throw new Error("Decision-ledger delta observation count is inconsistent.");
  }
  return delta;
}

function effectiveOutcomeSummary(observations) {
  const byDecisionContext = new Map();
  for (const observation of observations) {
    if (!observation.artifactKey) continue;
    const key = canonicalJson([
      observation.artifactKey,
      observation.candidateEvidenceFingerprint,
      observation.policyFingerprint,
    ]);
    const group = byDecisionContext.get(key) ?? [];
    group.push(observation);
    byDecisionContext.set(key, group);
  }
  const counts = {};
  for (const group of byDecisionContext.values()) {
    const resolved = strongestObservations(group);
    const outcome = resolved.conflict ? "conflict" : resolved.observation?.outcome;
    if (outcome) counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function summarizeLedger(observations) {
  const effectiveOutcomes = effectiveOutcomeSummary(observations);
  return {
    papers: new Set(observations.map((observation) => observation.paperId).filter(Boolean)).size,
    exactVersions: new Set(
      observations.map((observation) => observation.artifactKey).filter(Boolean),
    ).size,
    policies: new Set(observations.map((observation) => observation.policyFingerprint)).size,
    observations: observations.length,
    terminalObservations: observations.filter(
      (observation) => observation.skipMode === "terminal",
    ).length,
    decisionContexts: Object.values(effectiveOutcomes).reduce(
      (total, count) => total + count,
      0,
    ),
    effectiveOutcomes,
  };
}

export function mergeDecisionLedger({
  ledger,
  delta,
  deltaArtifact,
  receiptArtifact,
}) {
  validateDecisionLedger(ledger);
  validateDecisionLedgerDelta(delta);
  if (!deltaArtifact?.sha256 || !receiptArtifact?.sha256) {
    throw new Error("Decision-ledger merge requires immutable delta and receipt artifacts.");
  }
  const existingImport = ledger.imports.find((entry) => entry.runId === delta.runId);
  const nextImport = {
    runId: delta.runId,
    generatedAt: delta.generatedAt,
    policyFingerprint: delta.policy.fingerprint,
    observationCount: delta.observations.length,
    delta: deltaArtifact,
    receipt: receiptArtifact,
  };
  if (existingImport && canonicalJson(existingImport) !== canonicalJson(nextImport)) {
    throw new Error(`Run '${delta.runId}' is already imported with different artifacts.`);
  }
  const observationsById = new Map(
    ledger.observations.map((observation) => [observation.observationId, observation]),
  );
  for (const observation of delta.observations) {
    const existing = observationsById.get(observation.observationId);
    if (existing && canonicalJson(existing) !== canonicalJson(observation)) {
      throw new Error(
        `Observation '${observation.observationId}' conflicts with the existing ledger.`,
      );
    }
    observationsById.set(observation.observationId, observation);
  }
  const observations = [...observationsById.values()].sort(
    (left, right) =>
      String(left.artifactKey ?? "").localeCompare(String(right.artifactKey ?? "")) ||
      left.policyFingerprint.localeCompare(right.policyFingerprint) ||
      String(left.decidedAt ?? "").localeCompare(String(right.decidedAt ?? "")) ||
      left.observationId.localeCompare(right.observationId),
  );
  const imports = existingImport
    ? [...ledger.imports]
    : [...ledger.imports, nextImport];
  imports.sort(
    (left, right) =>
      String(left.generatedAt ?? "").localeCompare(String(right.generatedAt ?? "")) ||
      left.runId.localeCompare(right.runId),
  );
  const generatedAt = imports.map((entry) => entry.generatedAt).filter(Boolean).sort().at(-1) ?? null;
  return {
    schemaVersion: DECISION_LEDGER_SCHEMA_VERSION,
    kind: DECISION_LEDGER_KIND,
    policyVersion: DECISION_LEDGER_POLICY_VERSION,
    generatedAt,
    imports,
    observations,
    summary: summarizeLedger(observations),
  };
}

function resolveArtifactInsideRoot(root, record, label, errors) {
  if (typeof record?.file !== "string" || typeof record?.sha256 !== "string") {
    errors.push(`${label} must contain file and sha256 strings.`);
    return null;
  }
  const resolved = path.isAbsolute(record.file)
    ? path.resolve(record.file)
    : path.resolve(root, record.file);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    errors.push(`${label} escapes the repository root.`);
    return null;
  }
  if (!existsSync(resolved)) {
    errors.push(`${label} is missing: ${record.file}.`);
    return null;
  }
  if (lstatSync(resolved).isSymbolicLink()) {
    errors.push(`${label} must not be a symbolic link.`);
    return null;
  }
  const realRoot = realpathSync(root);
  const realArtifact = realpathSync(resolved);
  const realRelative = path.relative(realRoot, realArtifact);
  if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    errors.push(`${label} resolves outside the repository root.`);
    return null;
  }
  if (sha256FileSync(resolved) !== record.sha256) {
    errors.push(`${label} hash changed: ${record.file}.`);
    return null;
  }
  return resolved;
}

function receiptBindsDelta(receipt, imported, errors) {
  if (
    receipt.kind !== "paper-reading-run-receipt" ||
    receipt.status !== "content-verified" ||
    receipt.runId !== imported.runId
  ) {
    errors.push(`Import '${imported.runId}' receipt identity/status is invalid.`);
    return false;
  }
  const pinned = receipt.decisionLedger?.delta;
  if (!pinned) {
    if (!LEGACY_DECISION_LEDGER_RUN_IDS.has(imported.runId)) {
      errors.push(`Import '${imported.runId}' receipt does not pin its decision delta.`);
    }
    return false;
  }
  if (
    path.normalize(pinned.file) !== path.normalize(imported.delta.file) ||
    pinned.sha256 !== imported.delta.sha256
  ) {
    errors.push(`Import '${imported.runId}' receipt pins a different decision delta.`);
  }
  return true;
}

function verifyLegacyDeltaAgainstRun({ delta, root, label, errors }) {
  const candidateRecord = delta?.sourceArtifacts?.candidates;
  const candidateFile = resolveArtifactInsideRoot(
    root,
    candidateRecord,
    `${label} source candidates`,
    errors,
  );
  if (!candidateFile) return;
  if (path.basename(candidateFile) !== "candidates.json") {
    errors.push(`${label} source candidates have an unexpected filename.`);
    return;
  }
  try {
    const expected = buildDecisionLedgerDelta({
      root,
      runDirectory: path.dirname(candidateFile),
    });
    if (canonicalJson(expected) !== canonicalJson(delta)) {
      errors.push(`${label} differs from receipt-verified legacy run artifacts.`);
    }
  } catch (error) {
    errors.push(`${label} cannot be rebuilt from legacy run artifacts: ${error.message}`);
  }
}

export function verifyDecisionLedgerImports({ ledger, root, runIds = null }) {
  validateDecisionLedger(ledger);
  const results = [];
  for (const imported of ledger.imports) {
    if (runIds && !runIds.has(imported.runId)) continue;
    const errors = [];
    const deltaFile = resolveArtifactInsideRoot(
      root,
      imported.delta,
      `Import '${imported.runId}' delta`,
      errors,
    );
    const receiptFile = resolveArtifactInsideRoot(
      root,
      imported.receipt,
      `Import '${imported.runId}' receipt`,
      errors,
    );
    let delta = null;
    if (deltaFile) {
      try {
        delta = validateDecisionLedgerDelta(
          JSON.parse(readFileSync(deltaFile, "utf8")),
        );
        if (delta.runId !== imported.runId) {
          errors.push(`Import '${imported.runId}' delta has another runId.`);
        }
        if (delta.policy.fingerprint !== imported.policyFingerprint) {
          errors.push(`Import '${imported.runId}' delta has another policy.`);
        }
        const aggregateObservations = ledger.observations
          .filter((observation) => observation.runId === imported.runId)
          .sort((left, right) => left.observationId.localeCompare(right.observationId));
        const deltaObservations = [...delta.observations].sort((left, right) =>
          left.observationId.localeCompare(right.observationId),
        );
        if (canonicalJson(aggregateObservations) !== canonicalJson(deltaObservations)) {
          errors.push(
            `Import '${imported.runId}' aggregate observations differ from its delta.`,
          );
        }
      } catch (error) {
        errors.push(`Import '${imported.runId}' delta is invalid: ${error.message}`);
      }
    }
    if (receiptFile) {
      try {
        const pinned = receiptBindsDelta(
          JSON.parse(readFileSync(receiptFile, "utf8")),
          imported,
          errors,
        );
        if (!pinned && LEGACY_DECISION_LEDGER_RUN_IDS.has(imported.runId) && delta) {
          verifyLegacyDeltaAgainstRun({
            delta,
            root,
            label: `Import '${imported.runId}' delta`,
            errors,
          });
        }
      } catch (error) {
        errors.push(`Import '${imported.runId}' receipt is invalid JSON: ${error.message}`);
      }
    }
    results.push({
      runId: imported.runId,
      verified: errors.length === 0,
      errors,
    });
  }
  return results;
}

export function verifyLedgerSnapshotMatch({ entry, root }) {
  const errors = [];
  const imported = {
    runId: entry?.runId,
    delta: entry?.sourceImport?.delta,
    receipt: entry?.sourceImport?.receipt,
  };
  const deltaFile = resolveArtifactInsideRoot(
    root,
    imported.delta,
    `Ledger skip '${entry?.candidateId}' delta`,
    errors,
  );
  const receiptFile = resolveArtifactInsideRoot(
    root,
    imported.receipt,
    `Ledger skip '${entry?.candidateId}' receipt`,
    errors,
  );
  if (deltaFile) {
    try {
      const delta = validateDecisionLedgerDelta(
        JSON.parse(readFileSync(deltaFile, "utf8")),
      );
      const observation = delta.observations.find(
        (candidate) => candidate.observationId === entry.observationId,
      );
      if (!observation) {
        errors.push(`Ledger skip '${entry.candidateId}' is absent from its delta.`);
      } else {
        const fields = [
          "artifactKey",
          "candidateEvidenceFingerprint",
          "policyFingerprint",
          "outcome",
          "skipMode",
          "runId",
          "decidedAt",
        ];
        for (const field of fields) {
          if (entry[field] !== observation[field]) {
            errors.push(
              `Ledger skip '${entry.candidateId}' ${field} differs from its delta.`,
            );
          }
        }
        if (entry.sourceCandidateId !== observation.candidateId) {
          errors.push(`Ledger skip '${entry.candidateId}' source candidate differs from its delta.`);
        }
      }
    } catch (error) {
      errors.push(`Ledger skip '${entry?.candidateId}' delta is invalid: ${error.message}`);
    }
  }
  if (receiptFile) {
    try {
      const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
      const pinned = receiptBindsDelta(
        receipt,
        imported,
        errors,
      );
      if (!pinned && LEGACY_DECISION_LEDGER_RUN_IDS.has(imported.runId) && deltaFile) {
        verifyLegacyDeltaAgainstRun({
          delta: validateDecisionLedgerDelta(
            JSON.parse(readFileSync(deltaFile, "utf8")),
          ),
          root,
          label: `Ledger skip '${entry?.candidateId}' delta`,
          errors,
        });
      }
    } catch (error) {
      errors.push(`Ledger skip '${entry?.candidateId}' receipt is invalid: ${error.message}`);
    }
  }
  return { verified: errors.length === 0, errors };
}

export function buildDecisionLedgerSnapshot({
  ledger,
  ledgerFile,
  policy,
  candidates,
  canonicalExactVersions,
  generatedAt,
  root,
  ignoreLedger = false,
}) {
  validateDecisionLedger(ledger);
  const candidateEvidenceKeys = new Set(
    candidates.map((candidate) => {
      const exact = buildExactDecisionIdentity(candidate);
      return `${exact.identity?.artifactKey ?? ""}|${candidateEvidenceFingerprint(candidate)}`;
    }),
  );
  const relevantRunIds = new Set(
    ledger.observations
      .filter(
        (observation) =>
          !ignoreLedger &&
          observation.policyFingerprint === policy.fingerprint &&
          candidateEvidenceKeys.has(
            `${observation.artifactKey ?? ""}|${observation.candidateEvidenceFingerprint}`,
          ),
      )
      .map((observation) => observation.runId),
  );
  const importProofs = verifyDecisionLedgerImports({
    ledger,
    root,
    runIds: relevantRunIds,
  });
  const verifiedRunIds = new Set(
    importProofs.filter((proof) => proof.verified).map((proof) => proof.runId),
  );
  const matchingLedger = {
    ...ledger,
    observations: ignoreLedger ? [] : ledger.observations,
  };
  const matches = [];
  const misses = [];
  const missReasons = {};
  for (const candidate of candidates) {
    const result = matchCandidateAgainstLedger({
      candidate,
      ledger: matchingLedger,
      policy,
      canonicalExactVersions,
    });
    if (ignoreLedger) result.reason = "manual-ledger-bypass";
    if (
      result.matched &&
      !verifiedRunIds.has(result.observation.runId)
    ) {
      result.matched = false;
      result.reason = "decision-ledger-import-proof-failed";
    }
    if (!result.matched) {
      missReasons[result.reason] = (missReasons[result.reason] ?? 0) + 1;
      misses.push({
        candidateId: candidate.discoveryId,
        artifactKey: result.identity?.artifactKey ?? null,
        candidateEvidenceFingerprint: result.evidenceFingerprint,
        policyFingerprint: policy.fingerprint,
        reason: result.reason,
      });
      continue;
    }
    const imported = ledger.imports.find(
      (entry) => entry.runId === result.observation.runId,
    );
    matches.push({
      candidateId: candidate.discoveryId,
      artifactKey: result.identity.artifactKey,
      candidateEvidenceFingerprint: result.evidenceFingerprint,
      policyFingerprint: policy.fingerprint,
      observationId: result.observation.observationId,
      outcome: result.observation.outcome,
      skipMode: result.observation.skipMode,
      runId: result.observation.runId,
      sourceCandidateId: result.observation.candidateId,
      decidedAt: result.observation.decidedAt,
      sourceImport: {
        delta: imported.delta,
        receipt: imported.receipt,
      },
    });
  }
  matches.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  misses.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  return {
    schemaVersion: DECISION_LEDGER_SCHEMA_VERSION,
    kind: DECISION_LEDGER_SNAPSHOT_KIND,
    generatedAt,
    override: { ignoreDecisionLedger: ignoreLedger },
    policy,
    ledger: existsSync(ledgerFile)
      ? { file: displayPath(root, ledgerFile), sha256: sha256FileSync(ledgerFile) }
      : { file: displayPath(root, ledgerFile), sha256: null },
    importProofs,
    counts: {
      candidates: candidates.length,
      matched: matches.length,
      unmatched: candidates.length - matches.length,
      missReasons: Object.fromEntries(
        Object.entries(missReasons).sort(([left], [right]) => left.localeCompare(right)),
      ),
    },
    matches,
    misses,
  };
}
