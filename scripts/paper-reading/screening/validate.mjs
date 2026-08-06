#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  ATTENTION_GATE_OUTCOMES,
  DECISIONS,
  DOWNSTREAM_CLAIM_SCOPES,
  GATE_REASON_BY_OUTCOME,
  NEGATIVE_REASON_BY_STATUS,
  NEGATIVE_SIGNAL_STATUSES,
  READING_ACTIONS,
  REASON_CODES,
  RELEVANCE_LEVELS,
  SCREENING_BASES,
  SCREENING_SCHEMA_VERSION,
  SIGNIFICANCE_LEVELS,
  SIGNIFICANCE_REASON_BY_LEVEL,
  SOURCE_SCOPES,
  TOPIC_MATCHES,
  TOPIC_REASON_BY_MATCH,
} from "./contract.mjs";
import { listJsonFiles, pathExists, readJson, sha256File } from "./io.mjs";

const sets = {
  decisions: new Set(DECISIONS),
  topicMatches: new Set(TOPIC_MATCHES),
  significance: new Set(SIGNIFICANCE_LEVELS),
  negativeStatuses: new Set(NEGATIVE_SIGNAL_STATUSES),
  sourceScopes: new Set(SOURCE_SCOPES),
  relevance: new Set(RELEVANCE_LEVELS),
  readingActions: new Set(READING_ACTIONS),
  gateOutcomes: new Set(ATTENTION_GATE_OUTCOMES),
  screeningBases: new Set(SCREENING_BASES),
  downstreamClaimScopes: new Set(DOWNSTREAM_CLAIM_SCOPES),
  reasonCodes: new Set(REASON_CODES),
};

export function parseArguments(argv) {
  const options = { reviewFiles: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${argument} requires a value.`);
      return argv[index];
    };
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--run-dir") options.runDirectory = next();
    else if (argument === "--screening-dir") options.screeningDirectory = next();
    else if (argument === "--reviews-dir") options.reviewsDirectory = next();
    else if (argument === "--review") options.reviewFiles.push(next());
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.reviewFiles.length && options.reviewsDirectory) {
    throw new Error("Use either one or more --review files or --reviews-dir, not both.");
  }
  return options;
}

function helpText() {
  return `Validate Paper Reading screening reviewer output

Usage:
  npm run validate:paper-screening -- --run-dir <discovery-run-directory> [options]

Options:
  --run-dir <directory>       Discovery run containing the screening directory.
  --screening-dir <directory> Default: <run-dir>/screening.
  --reviews-dir <directory>   Default: <screening-dir>/reviews.
  --review <file>             Validate an explicit review file; repeat for each batch.
  --help                      Show this help.

The validator is read-only. It requires one review document per batch and exactly one
contract-valid decision for every discovery candidate.`;
}

function resolveFrom(root, value) {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function codePointLength(value) {
  return [...value].length;
}

function validateShortText(value, label, maximum, errors) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${label} must be a non-empty string.`);
    return;
  }
  if (codePointLength(value.trim()) > maximum) {
    errors.push(`${label} must be at most ${maximum} Unicode code points.`);
  }
}

function validateEnum(value, allowed, label, errors) {
  if (!allowed.has(value)) {
    errors.push(`${label} must be one of: ${[...allowed].join(", ")}.`);
    return false;
  }
  return true;
}

function validateUniqueTextArray(value, label, errors, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array.`);
    return null;
  }
  if (!allowEmpty && value.length === 0) errors.push(`${label} must not be empty.`);
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      errors.push(`${label} entries must be non-empty strings.`);
      continue;
    }
    if (seen.has(item)) errors.push(`${label} contains duplicate value '${item}'.`);
    seen.add(item);
  }
  return seen;
}

function requireObject(value, label, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object.`);
    return false;
  }
  return true;
}

function requireFields(value, fields, label, errors) {
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) errors.push(`${label}.${field} is required.`);
  }
}

function requireReason(reasonCodes, expected, label, errors) {
  if (expected && !reasonCodes?.has(expected)) {
    errors.push(`${label}.reasonCodes must include '${expected}'.`);
  }
}

function validateDecision({
  decision,
  label,
  candidate,
  topicById,
  facetValuesByDimension,
  errors,
}) {
  if (!requireObject(decision, label, errors)) return;
  requireFields(
    decision,
    [
      "candidateId",
      "decision",
      "primaryTopicId",
      "secondaryTopicIds",
      "topicMatch",
      "significance",
      "reasonCodes",
      "rationaleZh",
      "negativeSignalAssessment",
      "attentionGate",
      "suggestedSourceScope",
      "preliminary",
      "facetHints",
      "evidenceBoundary",
    ],
    label,
    errors,
  );

  const decisionValid = validateEnum(
    decision.decision,
    sets.decisions,
    `${label}.decision`,
    errors,
  );
  const topicMatchValid = validateEnum(
    decision.topicMatch,
    sets.topicMatches,
    `${label}.topicMatch`,
    errors,
  );
  const significanceValid = validateEnum(
    decision.significance,
    sets.significance,
    `${label}.significance`,
    errors,
  );
  validateShortText(decision.rationaleZh, `${label}.rationaleZh`, 300, errors);

  const reasonCodes = validateUniqueTextArray(
    decision.reasonCodes,
    `${label}.reasonCodes`,
    errors,
    { allowEmpty: false },
  );
  for (const reasonCode of reasonCodes ?? []) {
    if (!sets.reasonCodes.has(reasonCode)) {
      errors.push(`${label}.reasonCodes contains unknown code '${reasonCode}'.`);
    }
  }
  if (topicMatchValid) {
    requireReason(reasonCodes, TOPIC_REASON_BY_MATCH[decision.topicMatch], label, errors);
  }
  if (significanceValid) {
    requireReason(
      reasonCodes,
      SIGNIFICANCE_REASON_BY_LEVEL[decision.significance],
      label,
      errors,
    );
  }

  let primaryTopic = null;
  if (decision.primaryTopicId !== null) {
    if (typeof decision.primaryTopicId !== "string" || !topicById.has(decision.primaryTopicId)) {
      errors.push(`${label}.primaryTopicId must be null or a configured topic ID.`);
    } else {
      primaryTopic = topicById.get(decision.primaryTopicId);
    }
  }
  const secondaryTopicIds = validateUniqueTextArray(
    decision.secondaryTopicIds,
    `${label}.secondaryTopicIds`,
    errors,
  );
  for (const topicId of secondaryTopicIds ?? []) {
    if (!topicById.has(topicId)) {
      errors.push(`${label}.secondaryTopicIds contains unknown topic '${topicId}'.`);
    }
    if (topicId === decision.primaryTopicId) {
      errors.push(`${label}.secondaryTopicIds must not repeat primaryTopicId '${topicId}'.`);
    }
  }
  if (decision.topicMatch === "none") {
    if (decision.primaryTopicId !== null) {
      errors.push(`${label}.primaryTopicId must be null when topicMatch is 'none'.`);
    }
    if (secondaryTopicIds?.size) {
      errors.push(`${label}.secondaryTopicIds must be empty when topicMatch is 'none'.`);
    }
  } else if (topicMatchValid && !primaryTopic) {
    errors.push(`${label}.primaryTopicId is required when topicMatch is not 'none'.`);
  }
  if (
    decisionValid &&
    ["accept-from-abstract", "full-text-review"].includes(decision.decision) &&
    decision.topicMatch === "none"
  ) {
    errors.push(`${label}.${decision.decision} requires a tracked topic match.`);
  }
  if (
    primaryTopic &&
    !candidate.retrievalTopicIds.includes(primaryTopic.id) &&
    !reasonCodes?.has("cross-routed")
  ) {
    errors.push(
      `${label}.reasonCodes must include 'cross-routed' because primaryTopicId was not a retrieval topic.`,
    );
  }

  if (requireObject(decision.attentionGate, `${label}.attentionGate`, errors)) {
    requireFields(
      decision.attentionGate,
      ["policyId", "outcome", "rationaleZh"],
      `${label}.attentionGate`,
      errors,
    );
    const gateValid = validateEnum(
      decision.attentionGate.outcome,
      sets.gateOutcomes,
      `${label}.attentionGate.outcome`,
      errors,
    );
    validateShortText(
      decision.attentionGate.rationaleZh,
      `${label}.attentionGate.rationaleZh`,
      240,
      errors,
    );
    if (primaryTopic) {
      if (decision.attentionGate.policyId !== primaryTopic.attentionPolicy) {
        errors.push(
          `${label}.attentionGate.policyId must be '${primaryTopic.attentionPolicy}' for primary topic '${primaryTopic.id}'.`,
        );
      }
    } else if (decision.attentionGate.policyId !== null) {
      errors.push(`${label}.attentionGate.policyId must be null without a primary topic.`);
    }
    if (gateValid) {
      requireReason(
        reasonCodes,
        GATE_REASON_BY_OUTCOME[decision.attentionGate.outcome],
        label,
        errors,
      );
    }
    if (decision.decision === "accept-from-abstract" && decision.attentionGate.outcome !== "pass") {
      errors.push(`${label}.accept-from-abstract requires attentionGate.outcome 'pass'.`);
    }
    if (decision.decision === "full-text-review" && decision.attentionGate.outcome === "fail") {
      errors.push(`${label}.full-text-review cannot proceed after an attention gate failure.`);
    }
    if (
      decision.decision === "accept-from-abstract" &&
      decision.significance === "incremental" &&
      primaryTopic?.attentionGate?.allowIncremental === false
    ) {
      errors.push(
        `${label}.accept-from-abstract cannot pass an incremental paper under attention policy '${primaryTopic.attentionPolicy}'.`,
      );
    }
  }

  if (
    requireObject(
      decision.negativeSignalAssessment,
      `${label}.negativeSignalAssessment`,
      errors,
    )
  ) {
    requireFields(
      decision.negativeSignalAssessment,
      ["status", "matchedSignals", "rationaleZh"],
      `${label}.negativeSignalAssessment`,
      errors,
    );
    const statusValid = validateEnum(
      decision.negativeSignalAssessment.status,
      sets.negativeStatuses,
      `${label}.negativeSignalAssessment.status`,
      errors,
    );
    const matchedSignals = validateUniqueTextArray(
      decision.negativeSignalAssessment.matchedSignals,
      `${label}.negativeSignalAssessment.matchedSignals`,
      errors,
    );
    validateShortText(
      decision.negativeSignalAssessment.rationaleZh,
      `${label}.negativeSignalAssessment.rationaleZh`,
      240,
      errors,
    );
    if (statusValid && decision.negativeSignalAssessment.status === "none") {
      if (matchedSignals?.size) {
        errors.push(
          `${label}.negativeSignalAssessment.matchedSignals must be empty when status is 'none'.`,
        );
      }
    } else if (statusValid) {
      if (!matchedSignals?.size) {
        errors.push(
          `${label}.negativeSignalAssessment.matchedSignals must identify at least one signal for status '${decision.negativeSignalAssessment.status}'.`,
        );
      }
      requireReason(
        reasonCodes,
        NEGATIVE_REASON_BY_STATUS[decision.negativeSignalAssessment.status],
        label,
        errors,
      );
    }
  }

  const sourceScopeValid = validateEnum(
    decision.suggestedSourceScope,
    sets.sourceScopes,
    `${label}.suggestedSourceScope`,
    errors,
  );
  if (requireObject(decision.preliminary, `${label}.preliminary`, errors)) {
    requireFields(
      decision.preliminary,
      ["relevance", "readingAction"],
      `${label}.preliminary`,
      errors,
    );
    validateEnum(
      decision.preliminary.relevance,
      sets.relevance,
      `${label}.preliminary.relevance`,
      errors,
    );
    validateEnum(
      decision.preliminary.readingAction,
      sets.readingActions,
      `${label}.preliminary.readingAction`,
      errors,
    );
  }

  if (requireObject(decision.facetHints, `${label}.facetHints`, errors)) {
    for (const [dimensionId, values] of Object.entries(decision.facetHints)) {
      const allowedValues = facetValuesByDimension.get(dimensionId);
      if (!allowedValues) {
        errors.push(`${label}.facetHints references unknown dimension '${dimensionId}'.`);
        continue;
      }
      const facetValues = validateUniqueTextArray(
        values,
        `${label}.facetHints.${dimensionId}`,
        errors,
        { allowEmpty: false },
      );
      for (const value of facetValues ?? []) {
        if (!allowedValues.has(value)) {
          errors.push(
            `${label}.facetHints.${dimensionId} contains unknown value '${value}'.`,
          );
        }
      }
    }
  }

  if (requireObject(decision.evidenceBoundary, `${label}.evidenceBoundary`, errors)) {
    requireFields(
      decision.evidenceBoundary,
      ["screeningBasis", "basisSufficientForDecision", "downstreamClaimScope"],
      `${label}.evidenceBoundary`,
      errors,
    );
    const basisValid = validateEnum(
      decision.evidenceBoundary.screeningBasis,
      sets.screeningBases,
      `${label}.evidenceBoundary.screeningBasis`,
      errors,
    );
    const claimScopeValid = validateEnum(
      decision.evidenceBoundary.downstreamClaimScope,
      sets.downstreamClaimScopes,
      `${label}.evidenceBoundary.downstreamClaimScope`,
      errors,
    );
    if (typeof decision.evidenceBoundary.basisSufficientForDecision !== "boolean") {
      errors.push(`${label}.evidenceBoundary.basisSufficientForDecision must be boolean.`);
    }

    if (decision.decision === "accept-from-abstract") {
      if (!candidate.abstract?.trim()) {
        errors.push(`${label}.accept-from-abstract requires a non-empty candidate abstract.`);
      }
      if (decision.suggestedSourceScope !== "abstract") {
        errors.push(`${label}.accept-from-abstract requires suggestedSourceScope 'abstract'.`);
      }
      if (
        decision.evidenceBoundary.screeningBasis !== "abstract" ||
        decision.evidenceBoundary.basisSufficientForDecision !== true ||
        decision.evidenceBoundary.downstreamClaimScope !== "abstract-only"
      ) {
        errors.push(
          `${label}.accept-from-abstract requires abstract / sufficient / abstract-only evidenceBoundary; downstream summaries must not claim full-text evidence.`,
        );
      }
      requireReason(reasonCodes, "abstract-sufficient", label, errors);
    }
    if (decision.decision === "full-text-review") {
      if (decision.suggestedSourceScope !== "full_text") {
        errors.push(`${label}.full-text-review requires suggestedSourceScope 'full_text'.`);
      }
      if (
        decision.evidenceBoundary.basisSufficientForDecision !== false ||
        decision.evidenceBoundary.downstreamClaimScope !== "full-text-required"
      ) {
        errors.push(
          `${label}.full-text-review requires insufficient current evidence and downstreamClaimScope 'full-text-required'.`,
        );
      }
      requireReason(reasonCodes, "needs-full-text", label, errors);
    }
    if (decision.decision === "manual-review") {
      if (
        decision.evidenceBoundary.basisSufficientForDecision !== false ||
        decision.evidenceBoundary.downstreamClaimScope !== "manual-verification-required"
      ) {
        errors.push(
          `${label}.manual-review requires insufficient current evidence and downstreamClaimScope 'manual-verification-required'.`,
        );
      }
      requireReason(reasonCodes, "manual-review-needed", label, errors);
    }
    if (decision.decision === "reject") {
      if (decision.evidenceBoundary.basisSufficientForDecision !== true) {
        errors.push(`${label}.reject requires sufficient metadata or abstract evidence.`);
      }
      if (basisValid && claimScopeValid && sourceScopeValid) {
        const expected =
          decision.evidenceBoundary.screeningBasis === "metadata"
            ? { source: "metadata", claim: "metadata-only" }
            : { source: "abstract", claim: "abstract-only" };
        if (
          decision.suggestedSourceScope !== expected.source ||
          decision.evidenceBoundary.downstreamClaimScope !== expected.claim
        ) {
          errors.push(
            `${label}.reject source scope and downstream claim scope must match its screening basis.`,
          );
        }
      }
    }
  }
}

async function loadBatchInputs(runDirectory, manifest, errors) {
  const batches = new Map();
  const allCandidateIds = new Set();
  for (const [index, batchRecord] of (manifest.batches ?? []).entries()) {
    const label = `screening manifest batch[${index}]`;
    if (!batchRecord || typeof batchRecord !== "object") {
      errors.push(`${label} must be an object.`);
      continue;
    }
    if (typeof batchRecord.batchId !== "string" || batches.has(batchRecord.batchId)) {
      errors.push(`${label}.batchId must be a unique non-empty string.`);
      continue;
    }
    if (typeof batchRecord.inputFile !== "string") {
      errors.push(`${label}.inputFile must be a string.`);
      continue;
    }
    const inputFile = resolveFrom(runDirectory, batchRecord.inputFile);
    if (!(await pathExists(inputFile))) {
      errors.push(`${label}.inputFile does not exist: ${inputFile}.`);
      continue;
    }
    if (batchRecord.inputSha256 && (await sha256File(inputFile)) !== batchRecord.inputSha256) {
      errors.push(`${label}.inputFile hash no longer matches the prepared manifest.`);
      continue;
    }
    const input = await readJson(inputFile);
    if (input.schemaVersion !== SCREENING_SCHEMA_VERSION) {
      errors.push(`${label} input schemaVersion must be ${SCREENING_SCHEMA_VERSION}.`);
    }
    if (input.kind !== "paper-reading-screening-input") {
      errors.push(`${label} input kind must be 'paper-reading-screening-input'.`);
    }
    if (input.runId !== manifest.runId || input.batchId !== batchRecord.batchId) {
      errors.push(`${label} input runId/batchId does not match the screening manifest.`);
    }
    if (!Array.isArray(input.candidates)) {
      errors.push(`${label} input candidates must be an array.`);
      continue;
    }
    const inputIds = input.candidates.map((candidate) => candidate.discoveryId);
    if (JSON.stringify(inputIds) !== JSON.stringify(batchRecord.candidateIds)) {
      errors.push(`${label} candidateIds do not match the prepared batch input.`);
    }
    for (const candidate of input.candidates) {
      if (!candidate.discoveryId || allCandidateIds.has(candidate.discoveryId)) {
        errors.push(`${label} contains a missing or duplicate discoveryId.`);
      }
      allCandidateIds.add(candidate.discoveryId);
    }
    batches.set(batchRecord.batchId, { record: batchRecord, input, inputFile });
  }
  return { batches, allCandidateIds };
}

function buildPolicyIndexes(batches, errors) {
  const topicById = new Map();
  const facetValuesByDimension = new Map();
  for (const { input } of batches.values()) {
    for (const direction of input.policyContext?.directions ?? []) {
      if (!topicById.has(direction.id)) topicById.set(direction.id, direction);
      else if (
        topicById.get(direction.id).attentionPolicy !== direction.attentionPolicy
      ) {
        errors.push(`Prepared batches disagree about topic '${direction.id}'.`);
      }
    }
    for (const dimension of input.policyContext?.facetTaxonomy?.dimensions ?? []) {
      const values = new Set((dimension.values ?? []).map((value) => value.id));
      if (!facetValuesByDimension.has(dimension.id)) {
        facetValuesByDimension.set(dimension.id, values);
      } else if (
        JSON.stringify([...facetValuesByDimension.get(dimension.id)].sort()) !==
        JSON.stringify([...values].sort())
      ) {
        errors.push(`Prepared batches disagree about facet dimension '${dimension.id}'.`);
      }
    }
  }
  return { topicById, facetValuesByDimension };
}

async function resolveReviewFiles({
  root,
  screeningDirectory,
  reviewFiles,
  reviewsDirectory,
  expectedCount,
}) {
  if (reviewFiles?.length) return reviewFiles.map((file) => resolveFrom(root, file));
  const directory = resolveFrom(
    root,
    reviewsDirectory ?? path.join(screeningDirectory, "reviews"),
  );
  if (!(await pathExists(directory))) {
    if (expectedCount === 0) return [];
    throw new Error(`Review directory does not exist: ${directory}.`);
  }
  return listJsonFiles(directory);
}

export async function validateScreeningReviews(inputOptions = {}) {
  const root = path.resolve(inputOptions.root ?? process.cwd());
  if (!inputOptions.runDirectory) throw new Error("--run-dir is required.");
  const runDirectory = resolveFrom(root, inputOptions.runDirectory);
  const screeningDirectory = resolveFrom(
    root,
    inputOptions.screeningDirectory ?? path.join(runDirectory, "screening"),
  );
  const screeningManifestFile = path.join(screeningDirectory, "screening-manifest.json");
  const manifest = await readJson(screeningManifestFile);
  const errors = [];
  if (manifest.schemaVersion !== SCREENING_SCHEMA_VERSION) {
    errors.push(`screening manifest schemaVersion must be ${SCREENING_SCHEMA_VERSION}.`);
  }
  if (manifest.kind !== "paper-reading-screening-manifest") {
    errors.push("screening manifest kind must be 'paper-reading-screening-manifest'.");
  }
  if (!Array.isArray(manifest.batches)) errors.push("screening manifest batches must be an array.");

  const { batches, allCandidateIds } = await loadBatchInputs(
    runDirectory,
    manifest,
    errors,
  );
  if (manifest.counts?.candidates !== allCandidateIds.size) {
    errors.push(
      `screening manifest expects ${manifest.counts?.candidates} candidates but prepared batches contain ${allCandidateIds.size}.`,
    );
  }
  const { topicById, facetValuesByDimension } = buildPolicyIndexes(batches, errors);
  const reviewFiles = await resolveReviewFiles({
    root,
    screeningDirectory,
    reviewFiles: inputOptions.reviewFiles,
    reviewsDirectory: inputOptions.reviewsDirectory,
    expectedCount: allCandidateIds.size,
  });

  const seenBatches = new Map();
  const seenCandidates = new Map();
  const decisionCounts = Object.fromEntries(DECISIONS.map((decision) => [decision, 0]));
  for (const reviewFile of reviewFiles) {
    const review = await readJson(reviewFile);
    const fileLabel = path.basename(reviewFile);
    if (!review || typeof review !== "object" || Array.isArray(review)) {
      errors.push(`${fileLabel} must contain a review object.`);
      continue;
    }
    requireFields(
      review,
      ["schemaVersion", "kind", "runId", "batchId", "reviewer", "reviewedAt", "decisions"],
      fileLabel,
      errors,
    );
    if (review.schemaVersion !== SCREENING_SCHEMA_VERSION) {
      errors.push(`${fileLabel}.schemaVersion must be ${SCREENING_SCHEMA_VERSION}.`);
    }
    if (review.kind !== "paper-reading-screening-review") {
      errors.push(`${fileLabel}.kind must be 'paper-reading-screening-review'.`);
    }
    if (review.runId !== manifest.runId) {
      errors.push(`${fileLabel}.runId must be '${manifest.runId}'.`);
    }
    const batch = batches.get(review.batchId);
    if (!batch) {
      errors.push(`${fileLabel}.batchId '${review.batchId}' is not a prepared batch.`);
    } else if (seenBatches.has(review.batchId)) {
      errors.push(
        `${fileLabel} duplicates batch '${review.batchId}' already reviewed by ${seenBatches.get(review.batchId)}.`,
      );
    } else {
      seenBatches.set(review.batchId, fileLabel);
    }

    if (requireObject(review.reviewer, `${fileLabel}.reviewer`, errors)) {
      requireFields(review.reviewer, ["kind", "name"], `${fileLabel}.reviewer`, errors);
      if (!new Set(["ai", "human"]).has(review.reviewer.kind)) {
        errors.push(`${fileLabel}.reviewer.kind must be 'ai' or 'human'.`);
      }
      validateShortText(review.reviewer.name, `${fileLabel}.reviewer.name`, 120, errors);
      if (review.reviewer.kind === "ai") {
        validateShortText(review.reviewer.model, `${fileLabel}.reviewer.model`, 120, errors);
      }
    }
    if (typeof review.reviewedAt !== "string" || Number.isNaN(Date.parse(review.reviewedAt))) {
      errors.push(`${fileLabel}.reviewedAt must be an ISO-compatible timestamp.`);
    }
    if (!Array.isArray(review.decisions)) {
      errors.push(`${fileLabel}.decisions must be an array.`);
      continue;
    }
    if (batch && review.decisions.length !== batch.input.candidates.length) {
      errors.push(
        `${fileLabel}.decisions must contain exactly ${batch.input.candidates.length} decisions for its batch.`,
      );
    }
    const candidateById = new Map(
      (batch?.input.candidates ?? []).map((candidate) => [candidate.discoveryId, candidate]),
    );
    for (const [index, decision] of review.decisions.entries()) {
      const label = `${fileLabel}.decisions[${index}]`;
      const candidateId = decision?.candidateId;
      const candidate = candidateById.get(candidateId);
      if (!candidate) {
        errors.push(`${label}.candidateId '${candidateId}' does not belong to batch '${review.batchId}'.`);
        continue;
      }
      if (seenCandidates.has(candidateId)) {
        errors.push(
          `${label}.candidateId '${candidateId}' already has a decision in ${seenCandidates.get(candidateId)}.`,
        );
      } else {
        seenCandidates.set(candidateId, label);
      }
      validateDecision({
        decision,
        label,
        candidate,
        topicById,
        facetValuesByDimension,
        errors,
      });
      if (sets.decisions.has(decision.decision)) decisionCounts[decision.decision] += 1;
    }
  }

  for (const batchId of batches.keys()) {
    if (!seenBatches.has(batchId)) errors.push(`Prepared batch '${batchId}' has no review file.`);
  }
  for (const candidateId of allCandidateIds) {
    if (!seenCandidates.has(candidateId)) {
      errors.push(`Candidate '${candidateId}' does not have a reviewer decision.`);
    }
  }
  for (const candidateId of seenCandidates.keys()) {
    if (!allCandidateIds.has(candidateId)) {
      errors.push(`Unexpected candidate '${candidateId}' appears in reviewer output.`);
    }
  }

  if (errors.length) {
    throw new Error(
      `Screening review validation failed with ${errors.length} issue(s):\n- ${errors.join("\n- ")}`,
    );
  }

  return {
    runId: manifest.runId,
    batchCount: batches.size,
    reviewFileCount: reviewFiles.length,
    candidateCount: allCandidateIds.size,
    decisionCounts,
    guarantees: {
      everyCandidateExactlyOnce: true,
      canonicalPapersWritten: false,
      digestsWritten: false,
      sitePublished: false,
    },
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
    return;
  }
  const result = await validateScreeningReviews(options);
  console.log(
    `[paper-reading] valid screening review: ${result.candidateCount} candidates, ${result.batchCount} batches`,
  );
  console.log(
    `[paper-reading] decisions: ${Object.entries(result.decisionCounts)
      .map(([decision, count]) => `${decision}=${count}`)
      .join(", ")}`,
  );
  console.log("[paper-reading] validation does not accept, publish, or write canonical papers");
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[paper-reading] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
