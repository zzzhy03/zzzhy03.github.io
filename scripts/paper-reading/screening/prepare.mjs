#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  buildCanonicalExactVersionIndex,
  buildDecisionLedgerSnapshot,
  buildPolicyDescriptor,
  DEFAULT_DECISION_LEDGER_FILE,
  readDecisionLedgerSync,
} from "../decision-ledger.mjs";
import { buildReviewContract, SCREENING_SCHEMA_VERSION } from "./contract.mjs";
import {
  pathExists,
  readJson,
  relativeTo,
  sha256File,
  writeJsonAtomic,
} from "./io.mjs";

const DEFAULT_BATCH_SIZE = 12;

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

export function parseArguments(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${argument} requires a value.`);
      return argv[index];
    };

    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--run-dir") options.runDirectory = next();
    else if (argument === "--output-dir") options.outputDirectory = next();
    else if (argument === "--research-config") options.researchConfigFile = next();
    else if (argument === "--venue-registry") options.venueRegistryFile = next();
    else if (argument === "--decision-ledger") options.decisionLedgerFile = next();
    else if (argument === "--batch-size") {
      options.batchSize = parsePositiveInteger(next(), "--batch-size");
    } else if (argument === "--now") options.now = next();
    else if (argument === "--force") options.force = true;
    else if (argument === "--ignore-decision-ledger") {
      options.ignoreDecisionLedger = true;
    }
    else throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

function helpText() {
  return `Prepare Paper Reading screening inputs (local staging only)

Usage:
  npm run prepare:paper-screening -- --run-dir <discovery-run-directory> [options]

Options:
  --run-dir <directory>       Directory containing candidates.json and manifest.json.
  --output-dir <directory>    Default: <run-dir>/screening.
  --research-config <file>    Default: path recorded by discovery, then content config.
  --venue-registry <file>     Default: path recorded by discovery, then venue registry.
  --decision-ledger <file>    Default: content/paper-reading/state/decision-ledger.json.
  --batch-size <number>       Batch size after receipt-backed exact-version reuse (default: 12).
  --now <ISO timestamp>       Deterministic generation time for tests or audited reruns.
  --force                     Replace an existing screening manifest and batch inputs.
  --ignore-decision-ledger    Force every discovery candidate into this run's batches.
  --help                      Show this help.

Discovery candidates remain intact. Receipt-backed exact-version decisions are accounted for
in an immutable run snapshot; only ledger misses enter batches. The command does not call a
model, create decisions, write canonical papers or digests, build the site, or publish.`;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
}

function uniqueById(items, label) {
  const ids = new Set();
  for (const item of items) {
    requireObject(item, `${label} entry`);
    if (typeof item.id !== "string" || !item.id.trim()) {
      throw new Error(`${label} entries must have a non-empty id.`);
    }
    if (ids.has(item.id)) throw new Error(`${label} contains duplicate id '${item.id}'.`);
    ids.add(item.id);
  }
  return ids;
}

function validateInputs({ candidatePayload, discoveryManifest, researchConfig, venueRegistry }) {
  requireObject(candidatePayload, "candidates.json");
  requireObject(discoveryManifest, "manifest.json");
  requireObject(researchConfig, "research-config.json");
  requireObject(venueRegistry, "venue-registry.json");
  if (candidatePayload.schemaVersion !== 1) {
    throw new Error("candidates.json schemaVersion must be 1.");
  }
  if (discoveryManifest.schemaVersion !== 1) {
    throw new Error("discovery manifest schemaVersion must be 1.");
  }
  if (!candidatePayload.runId || candidatePayload.runId !== discoveryManifest.runId) {
    throw new Error("candidates.json and manifest.json must have the same non-empty runId.");
  }
  requireArray(candidatePayload.candidates, "candidates.json.candidates");
  requireArray(researchConfig.directions, "research-config.json.directions");
  requireObject(researchConfig.attentionPolicies, "research-config.json.attentionPolicies");
  requireObject(researchConfig.tagTaxonomy, "research-config.json.tagTaxonomy");
  requireArray(researchConfig.tagTaxonomy.dimensions, "tagTaxonomy.dimensions");
  requireArray(venueRegistry.venues, "venue-registry.json.venues");

  const topicIds = uniqueById(researchConfig.directions, "research directions");
  uniqueById(researchConfig.tagTaxonomy.dimensions, "facet dimensions");
  uniqueById(venueRegistry.venues, "venues");

  for (const direction of researchConfig.directions) {
    if (!researchConfig.attentionPolicies[direction.attentionPolicy]) {
      throw new Error(
        `Direction '${direction.id}' references unknown attention policy '${direction.attentionPolicy}'.`,
      );
    }
    for (const hint of direction.crossTopicHints ?? []) {
      if (!topicIds.has(hint.topicId)) {
        throw new Error(
          `Direction '${direction.id}' cross-routes to unknown topic '${hint.topicId}'.`,
        );
      }
    }
  }

  const candidateIds = new Set();
  for (const [index, candidate] of candidatePayload.candidates.entries()) {
    requireObject(candidate, `candidates[${index}]`);
    if (typeof candidate.discoveryId !== "string" || !candidate.discoveryId.trim()) {
      throw new Error(`candidates[${index}].discoveryId must be a non-empty string.`);
    }
    if (candidateIds.has(candidate.discoveryId)) {
      throw new Error(`Duplicate discoveryId '${candidate.discoveryId}'.`);
    }
    candidateIds.add(candidate.discoveryId);
    requireArray(candidate.retrievalTopicIds, `${candidate.discoveryId}.retrievalTopicIds`);
    for (const topicId of candidate.retrievalTopicIds) {
      if (!topicIds.has(topicId)) {
        throw new Error(
          `${candidate.discoveryId} has unknown retrieval topic '${topicId}'.`,
        );
      }
    }
  }

  const recordedCount = discoveryManifest.counts?.mergedCandidates;
  if (Number.isInteger(recordedCount) && recordedCount !== candidateIds.size) {
    throw new Error(
      `Discovery manifest records ${recordedCount} merged candidates but candidates.json contains ${candidateIds.size}.`,
    );
  }
}

function compactDirection(direction, attentionPolicies) {
  return {
    id: direction.id,
    labelZh: direction.labelZh,
    labelEn: direction.labelEn,
    attentionPolicy: direction.attentionPolicy,
    attentionGate: attentionPolicies[direction.attentionPolicy],
    descriptionZh: direction.descriptionZh,
    includeWhenZh: direction.includeWhenZh ?? [],
    excludeWhenZh: direction.excludeWhenZh ?? [],
    hardNegativeSignals: direction.search?.hardNegativeSignals ?? [],
    conditionalNegativeSignals: direction.search?.conditionalNegativeSignals ?? [],
    crossTopicHints: direction.crossTopicHints ?? [],
  };
}

function compactVenue(venue) {
  return {
    id: venue.id,
    name: venue.name,
    aliases: venue.aliases ?? [],
    kind: venue.kind,
    priority: venue.priority,
    scanPolicy: venue.scanPolicy,
    primaryTopicIds: venue.primaryTopicIds ?? [],
    secondaryTopicIds: venue.secondaryTopicIds ?? [],
  };
}

function buildPolicyContext(researchConfig, venueRegistry) {
  return {
    researchConfig: {
      schemaVersion: researchConfig.schemaVersion,
      status: researchConfig.status,
      reviewedAt: researchConfig.reviewedAt ?? null,
    },
    attentionPolicies: researchConfig.attentionPolicies,
    directions: researchConfig.directions.map((direction) =>
      compactDirection(direction, researchConfig.attentionPolicies),
    ),
    routingRules: researchConfig.routingRules ?? [],
    globalExclusions: researchConfig.globalExclusions ?? [],
    facetTaxonomy: researchConfig.tagTaxonomy,
    venuePolicy: {
      schemaVersion: venueRegistry.schemaVersion,
      status: venueRegistry.status,
      policyZh: venueRegistry.policyZh,
      aliasMatching: venueRegistry.aliasMatching ?? {},
      priorityDefinitions: venueRegistry.priorityDefinitions ?? {},
      scanPolicies: venueRegistry.scanPolicies ?? {},
      globalPolicyOverrides: venueRegistry.globalPolicyOverrides ?? [],
      nonVenueSources: venueRegistry.nonVenueSources ?? [],
      dedupe: venueRegistry.dedupe ?? {},
      venues: venueRegistry.venues.map(compactVenue),
    },
  };
}

function withScreeningContext(candidate, directionById, venueById) {
  return {
    ...candidate,
    screeningContext: {
      candidateId: candidate.discoveryId,
      retrievalTopicIdsAreFinalClassification: false,
      retrievalDirections: candidate.retrievalTopicIds.map((topicId) => {
        const direction = directionById.get(topicId);
        return {
          id: direction.id,
          labelZh: direction.labelZh,
          attentionPolicy: direction.attentionPolicy,
        };
      }),
      matchedVenues: (candidate.venueMatches ?? [])
        .map((match) => venueById.get(match.id))
        .filter(Boolean)
        .map(compactVenue),
      availableEvidence: {
        metadata: true,
        abstract: Boolean(candidate.abstract?.trim()),
        fullTextAcquired: false,
      },
      reminderZh:
        "请重新判断实际 primary/secondary topic，并按最终 primary topic 的 attention policy gate；允许跨方向路由。",
    },
  };
}

function chunk(values, size) {
  const batches = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}

function resolveConfigurationPath({ root, explicit, recorded, fallback }) {
  return path.resolve(root, explicit ?? recorded ?? fallback);
}

export async function prepareScreening(inputOptions = {}) {
  const root = path.resolve(inputOptions.root ?? process.cwd());
  if (!inputOptions.runDirectory) throw new Error("--run-dir is required.");
  const runDirectory = path.resolve(root, inputOptions.runDirectory);
  const candidatesFile = path.join(runDirectory, "candidates.json");
  const discoveryManifestFile = path.join(runDirectory, "manifest.json");
  const [candidatePayload, discoveryManifest] = await Promise.all([
    readJson(candidatesFile),
    readJson(discoveryManifestFile),
  ]);

  const researchConfigFile = resolveConfigurationPath({
    root,
    explicit: inputOptions.researchConfigFile,
    recorded: discoveryManifest.configuration?.researchConfig,
    fallback: path.join("content", "paper-reading", "research-config.json"),
  });
  const venueRegistryFile = resolveConfigurationPath({
    root,
    explicit: inputOptions.venueRegistryFile,
    recorded: discoveryManifest.configuration?.venueRegistry,
    fallback: path.join("content", "paper-reading", "venue-registry.json"),
  });
  const [researchConfig, venueRegistry] = await Promise.all([
    readJson(researchConfigFile),
    readJson(venueRegistryFile),
  ]);
  validateInputs({ candidatePayload, discoveryManifest, researchConfig, venueRegistry });

  const now = new Date(inputOptions.now ?? new Date().toISOString()).toISOString();
  const batchSize = inputOptions.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error("batchSize must be a positive integer.");
  }
  const outputDirectory = path.resolve(
    root,
    inputOptions.outputDirectory ?? path.join(runDirectory, "screening"),
  );
  const screeningManifestFile = path.join(outputDirectory, "screening-manifest.json");
  const ledgerSnapshotFile = path.join(outputDirectory, "decision-ledger-input.json");
  if (!inputOptions.force && (await pathExists(screeningManifestFile))) {
    throw new Error(
      `Screening manifest already exists at ${screeningManifestFile}; use --force to regenerate inputs.`,
    );
  }

  const contract = buildReviewContract();
  const [researchConfigSha256, venueRegistrySha256] = await Promise.all([
    sha256File(researchConfigFile),
    sha256File(venueRegistryFile),
  ]);
  const policy = buildPolicyDescriptor({
    researchConfigSha256,
    researchConfigStatus: researchConfig.status,
    venueRegistrySha256,
    venueRegistryStatus: venueRegistry.status,
    selectedTopicIds:
      discoveryManifest.configuration?.selectedTopicIds ??
      researchConfig.directions.map((direction) => direction.id),
    reviewContract: contract,
  });
  const decisionLedgerFile = path.resolve(
    root,
    inputOptions.decisionLedgerFile ?? DEFAULT_DECISION_LEDGER_FILE,
  );
  const decisionLedger = readDecisionLedgerSync(decisionLedgerFile);
  const canonicalExactVersions = buildCanonicalExactVersionIndex(
    path.join(root, "content", "paper-reading", "papers"),
  );
  const ledgerSnapshot = buildDecisionLedgerSnapshot({
    ledger: decisionLedger,
    ledgerFile: decisionLedgerFile,
    policy,
    candidates: candidatePayload.candidates,
    canonicalExactVersions,
    generatedAt: now,
    root,
    ignoreLedger: Boolean(inputOptions.ignoreDecisionLedger),
  });
  await writeJsonAtomic(ledgerSnapshotFile, ledgerSnapshot);
  const ledgerSkippedIds = new Set(
    ledgerSnapshot.matches.map((match) => match.candidateId),
  );
  const policyContext = buildPolicyContext(researchConfig, venueRegistry);
  const directionById = new Map(
    researchConfig.directions.map((direction) => [direction.id, direction]),
  );
  const venueById = new Map(venueRegistry.venues.map((venue) => [venue.id, venue]));
  const enrichedCandidates = candidatePayload.candidates
    .filter((candidate) => !ledgerSkippedIds.has(candidate.discoveryId))
    .map((candidate) => withScreeningContext(candidate, directionById, venueById));
  const candidateBatches = chunk(enrichedCandidates, batchSize);
  const batchRecords = [];

  for (const [index, candidates] of candidateBatches.entries()) {
    const batchId = `batch-${String(index + 1).padStart(3, "0")}`;
    const inputFile = path.join(outputDirectory, "batches", `${batchId}.input.json`);
    const reviewFile = path.join(outputDirectory, "reviews", `${batchId}.review.json`);
    const payload = {
      schemaVersion: SCREENING_SCHEMA_VERSION,
      kind: "paper-reading-screening-input",
      runId: candidatePayload.runId,
      batchId,
      generatedAt: now,
      stage: "screening-input-only",
      sourceWindow: candidatePayload.window ?? discoveryManifest.window ?? null,
      guarantees: {
        modelCalled: false,
        reviewerDecisionsGenerated: false,
        canonicalPapersWritten: false,
        digestsWritten: false,
        sitePublished: false,
      },
      reviewContract: contract,
      policyContext,
      candidateCount: candidates.length,
      candidates,
    };
    await writeJsonAtomic(inputFile, payload);
    batchRecords.push({
      batchId,
      inputFile: relativeTo(runDirectory, inputFile),
      inputSha256: await sha256File(inputFile),
      expectedReviewFile: relativeTo(runDirectory, reviewFile),
      candidateIds: candidates.map((candidate) => candidate.discoveryId),
    });
  }

  const screeningManifest = {
    schemaVersion: SCREENING_SCHEMA_VERSION,
    kind: "paper-reading-screening-manifest",
    runId: candidatePayload.runId,
    generatedAt: now,
    stage: "screening-input-only",
    noticeZh:
      "这些文件定义 AI 或人工初筛的输入与输出契约，并记录由既有 verified receipt 支持的 exact-version 跳过项；尚未运行本轮 reviewer，也没有新论文被正式收录。",
    guarantees: {
      allDiscoveryCandidatesAccountedFor: true,
      modelCalled: false,
      reviewerDecisionsGenerated: false,
      canonicalPapersWritten: false,
      digestsWritten: false,
      siteBuilt: false,
      sitePublished: false,
    },
    sourceInputs: {
      candidates: {
        file: relativeTo(runDirectory, candidatesFile),
        sha256: await sha256File(candidatesFile),
      },
      discoveryManifest: {
        file: relativeTo(runDirectory, discoveryManifestFile),
        sha256: await sha256File(discoveryManifestFile),
      },
      researchConfig: {
        file: relativeTo(runDirectory, researchConfigFile),
        sha256: researchConfigSha256,
        status: researchConfig.status,
      },
      venueRegistry: {
        file: relativeTo(runDirectory, venueRegistryFile),
        sha256: venueRegistrySha256,
        status: venueRegistry.status,
      },
      decisionLedgerSnapshot: {
        file: relativeTo(runDirectory, ledgerSnapshotFile),
        sha256: await sha256File(ledgerSnapshotFile),
      },
    },
    batching: {
      batchSize,
      policy: "ordered-lossless-ledger-miss-chunks",
      quotaApplied: false,
    },
    accounting: {
      policy: "screened-plus-ledger-skipped-equals-discovered",
      policyFingerprint: policy.fingerprint,
      policyDescriptor: policy,
      decisionLedgerBypassed: Boolean(inputOptions.ignoreDecisionLedger),
      ledgerSkippedCandidates: ledgerSnapshot.matches,
    },
    counts: {
      discoveredCandidates: candidatePayload.candidates.length,
      candidates: enrichedCandidates.length,
      ledgerSkippedCandidates: ledgerSnapshot.matches.length,
      batches: batchRecords.length,
    },
    reviewContract: contract,
    batches: batchRecords,
  };
  await writeJsonAtomic(screeningManifestFile, screeningManifest);

  return {
    runDirectory,
    outputDirectory,
    screeningManifestFile,
    screeningManifest,
    batchRecords,
    ledgerSnapshotFile,
    ledgerSnapshot,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
    return;
  }
  const result = await prepareScreening(options);
  console.log(
    `[paper-reading] prepared ${result.screeningManifest.counts.candidates} screening candidates in ${result.screeningManifest.counts.batches} batches; reused ${result.screeningManifest.counts.ledgerSkippedCandidates} receipt-backed exact decisions`,
  );
  console.log(`[paper-reading] screening manifest: ${result.screeningManifestFile}`);
  console.log("[paper-reading] no model was called and no paper was accepted or published");
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[paper-reading] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
