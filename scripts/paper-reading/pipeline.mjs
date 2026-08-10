#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildDecisionLedgerDelta,
  canonicalJson,
  DEFAULT_DECISION_LEDGER_FILE,
  mergeDecisionLedger,
  LEGACY_DECISION_LEDGER_RUN_IDS,
  readDecisionLedgerSync,
  validateDecisionLedgerDelta,
  verifyDecisionLedgerImports,
} from "./decision-ledger.mjs";
import { validateFulltextReviews } from "./fulltext/validate.mjs";
import { validatePromotion } from "./fulltext/validate-promotion.mjs";
import { writeJsonAtomic } from "./lib/io.mjs";
import { validateScreeningReviews } from "./screening/validate.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPOSITORY_ROOT = path.resolve(scriptDirectory, "../..");
const selections = new Set(["all-full-text", "high-deep"]);

function parseArguments(argv) {
  const options = { selection: "all-full-text" };
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    return { ...options, command: "help" };
  }
  options.command = command;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${argument} requires a value.`);
      return argv[index];
    };
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--run-dir") options.runDirectory = next();
    else if (argument === "--digest") options.digest = next();
    else if (argument === "--selection") options.selection = next();
    else if (argument === "--json") options.json = true;
    else if (argument === "--apply") options.apply = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!new Set(["status", "verify", "backlog", "receipt", "ledger", "finalize", "cleanup"]).has(options.command)) {
    throw new Error(`Unknown command '${options.command}'.`);
  }
  if (options.help) return options;
  if (!options.runDirectory) throw new Error("--run-dir <directory> is required.");
  if (!selections.has(options.selection)) {
    throw new Error("--selection must be 'all-full-text' or 'high-deep'.");
  }
  if (new Set(["verify", "receipt", "ledger", "finalize"]).has(options.command) && !options.digest) {
    throw new Error(`${options.command} requires --digest <content digest JSON>.`);
  }
  if (options.apply && !new Set(["backlog", "receipt", "ledger", "finalize", "cleanup"]).has(options.command)) {
    throw new Error("--apply is only valid for backlog, receipt, ledger, finalize or cleanup.");
  }
  return options;
}

function helpText() {
  return `Paper Reading pipeline control

Usage:
  npm run pipeline:papers -- status  --run-dir <run> [--selection <mode>] [--digest <file>] [--json]
  npm run pipeline:papers -- backlog --run-dir <run> --selection high-deep [--apply] [--json]
  npm run pipeline:papers -- verify  --run-dir <run> --selection <mode> --digest <file> [--json]
  npm run pipeline:papers -- receipt --run-dir <run> --selection <mode> --digest <file> [--apply] [--json]
  npm run pipeline:papers -- ledger --run-dir <run> --selection <mode> --digest <file> [--apply] [--json]
  npm run pipeline:papers -- finalize --run-dir <run> --selection <mode> --digest <file> [--apply] [--json]
  npm run pipeline:papers -- cleanup --run-dir <run> --selection <mode> [--digest <file>] [--apply] [--json]

Commands:
  status    Recompute discovery, screening, full-text, backlog and promotion state.
  backlog   Record screened full-text candidates intentionally deferred by this run's selection.
  verify    Run every read-only gate through canonical content validation.
  receipt   Build a compact, checked-in audit receipt; --apply writes it after verification.
  ledger    Build/import the run's immutable decision delta after receipt verification.
  finalize  Merge verified decisions, then advance the discovery watermark; dry-run by default.
  cleanup   Plan deletion of <run>/fulltext/work; --apply performs the checked deletion.

Defaults and safety:
  --selection defaults to all-full-text. high-deep is allowed only with an explicit backlog.
  backlog, receipt, ledger, finalize and cleanup are dry-runs unless --apply is present.
  A run must be one direct child of local-assets/paper-reading/runs; symlinks are rejected.
  Source PDFs, reviews, manifests, canonical content, digests and publication state are never
  cleanup targets. This tool does not call a model, promote content, commit, push, or publish.`;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function listJsonFiles(directory, predicate = () => true) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && predicate(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function repositoryPath(root, value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
}

function displayPath(root, value) {
  const relative = path.relative(root, value);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : value;
}

export function resolveRunDirectory(root, value) {
  const repositoryRoot = path.resolve(root);
  const runsRoot = path.join(repositoryRoot, "local-assets", "paper-reading", "runs");
  const resolved = repositoryPath(repositoryRoot, value);
  const relative = path.relative(runsRoot, resolved);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    path.dirname(relative) !== "."
  ) {
    throw new Error(`Run directory must be one direct child of '${runsRoot}'.`);
  }
  if (!existsSync(runsRoot) || !existsSync(resolved)) {
    throw new Error(`Run directory does not exist: ${resolved}.`);
  }
  if (lstatSync(runsRoot).isSymbolicLink() || lstatSync(resolved).isSymbolicLink()) {
    throw new Error("Run roots and run directories must not be symbolic links.");
  }
  const realRunsRoot = realpathSync(runsRoot);
  const realRun = realpathSync(resolved);
  const realRelative = path.relative(realRunsRoot, realRun);
  if (
    !realRelative ||
    realRelative.startsWith("..") ||
    path.isAbsolute(realRelative) ||
    path.dirname(realRelative) !== "."
  ) {
    throw new Error("Resolved run directory escapes the configured runs root.");
  }
  return realRun;
}

function discoveryStatus(runDirectory) {
  const candidatesFile = path.join(runDirectory, "candidates.json");
  const manifestFile = path.join(runDirectory, "manifest.json");
  if (!existsSync(candidatesFile) && !existsSync(manifestFile)) {
    return { state: "pending", candidateCount: 0, errors: [] };
  }
  const errors = [];
  let candidatePayload;
  let manifest;
  try {
    candidatePayload = readJson(candidatesFile);
  } catch (error) {
    errors.push(`Cannot read candidates.json: ${error.message}`);
  }
  try {
    manifest = readJson(manifestFile);
  } catch (error) {
    errors.push(`Cannot read manifest.json: ${error.message}`);
  }
  const candidates = Array.isArray(candidatePayload?.candidates) ? candidatePayload.candidates : [];
  if (!Array.isArray(candidatePayload?.candidates)) errors.push("candidates.json.candidates is missing.");
  if (candidatePayload?.runId !== manifest?.runId) {
    errors.push("Discovery candidates and manifest have different run IDs.");
  }
  if (
    Number.isInteger(manifest?.counts?.mergedCandidates) &&
    manifest.counts.mergedCandidates !== candidates.length
  ) {
    errors.push("Discovery manifest candidate count does not match candidates.json.");
  }
  const failedSources = (manifest?.sourceStatus ?? []).filter((source) =>
    new Set(["failed", "partial"]).has(source.status),
  );
  if (failedSources.length) {
    errors.push(
      `Discovery has non-complete sources: ${failedSources.map((source) => source.id).join(", ")}.`,
    );
  }
  return {
    state: errors.length ? "invalid" : "complete",
    runId: manifest?.runId ?? candidatePayload?.runId ?? null,
    candidateCount: candidates.length,
    sourceStatuses: Object.fromEntries(
      (manifest?.sourceStatus ?? []).map((source) => [source.id, source.status]),
    ),
    window: manifest?.window ?? null,
    errors,
  };
}

async function screeningStatus(root, runDirectory) {
  const screeningDirectory = path.join(runDirectory, "screening");
  const manifestFile = path.join(screeningDirectory, "screening-manifest.json");
  if (!existsSync(manifestFile)) {
    return { state: "pending", batchCount: 0, reviewCount: 0, errors: [] };
  }
  const manifest = readJson(manifestFile);
  const reviewCount = listJsonFiles(
    path.join(screeningDirectory, "reviews"),
    (name) => name.endsWith(".review.json"),
  ).length;
  try {
    const result = await validateScreeningReviews({ root, runDirectory });
    return {
      state: "complete",
      batchCount: result.batchCount,
      reviewCount: result.reviewFileCount,
      candidateCount: result.candidateCount,
      discoveredCandidateCount: result.discoveredCandidateCount,
      ledgerSkippedCandidateCount: result.ledgerSkippedCandidateCount,
      decisionCounts: result.decisionCounts,
      errors: [],
    };
  } catch (error) {
    return {
      state: reviewCount < (manifest.counts?.batches ?? 0) ? "incomplete" : "invalid",
      batchCount: manifest.counts?.batches ?? 0,
      reviewCount,
      candidateCount: manifest.counts?.candidates ?? null,
      discoveredCandidateCount: manifest.counts?.discoveredCandidates ?? null,
      ledgerSkippedCandidateCount: manifest.counts?.ledgerSkippedCandidates ?? 0,
      errors: [error.message],
    };
  }
}

function selectedFulltextDecisionCount(runDirectory, selection) {
  return listJsonFiles(
    path.join(runDirectory, "screening", "reviews"),
    (name) => name.endsWith(".review.json"),
  )
    .flatMap((file) => readJson(file).decisions ?? [])
    .filter((decision) => decision.decision === "full-text-review")
    .filter(
      (decision) =>
        selection === "all-full-text" ||
        (decision.preliminary?.relevance === "high" &&
          decision.preliminary?.readingAction === "deep"),
    ).length;
}

function fulltextStatus(root, runDirectory, selection, screeningState) {
  const reviewDirectory = path.join(runDirectory, "fulltext", "reviews");
  const reviewCount = listJsonFiles(reviewDirectory, (name) => name !== "summary.json").length;
  if (!reviewCount) {
    const expectedCount =
      screeningState === "complete"
        ? selectedFulltextDecisionCount(runDirectory, selection)
        : null;
    if (expectedCount === 0) {
      return {
        state: "complete",
        reviewCount: 0,
        expectedCount: 0,
        decisionCounts: {},
        topicCounts: {},
        errors: [],
      };
    }
    return { state: "pending", reviewCount: 0, expectedCount, errors: [] };
  }
  const result = validateFulltextReviews({
    root,
    reviewDirectory,
    researchConfig: "content/paper-reading/research-config.json",
    screeningRunDirectory: runDirectory,
    selection,
  });
  const missingOnly = result.errors.length > 0 && result.errors.every((error) =>
    error.startsWith("Missing full-text review"),
  );
  return {
    state: result.errors.length ? (missingOnly ? "incomplete" : "invalid") : "complete",
    reviewCount,
    expectedCount: result.counts.expected ?? null,
    decisionCounts: result.counts.byDecision ?? {},
    topicCounts: result.counts.byTopic ?? {},
    errors: result.errors,
  };
}

function fulltextClosure(runDirectory) {
  const candidatePayload = readJson(path.join(runDirectory, "candidates.json"));
  const candidates = candidatePayload.candidates ?? [];
  const candidateById = new Map(candidates.map((candidate) => [candidate.discoveryId, candidate]));
  const screeningDecisions = listJsonFiles(
    path.join(runDirectory, "screening", "reviews"),
    (name) => name.endsWith(".review.json"),
  ).flatMap((file) => readJson(file).decisions ?? []);
  const fulltextCandidates = screeningDecisions.filter(
    (decision) => decision.decision === "full-text-review",
  );
  const reviewedCandidateIds = new Set(
    listJsonFiles(
      path.join(runDirectory, "fulltext", "reviews"),
      (name) => name !== "summary.json",
    ).map((file) => readJson(file).candidateId),
  );
  const pending = fulltextCandidates
    .filter((decision) => !reviewedCandidateIds.has(decision.candidateId))
    .map((decision) => {
      const candidate = candidateById.get(decision.candidateId);
      return {
        candidateId: decision.candidateId,
        title: candidate?.title ?? null,
        arxivIds: candidate?.identifiers?.arxiv ?? [],
        primaryTopicId: decision.primaryTopicId,
        preliminary: decision.preliminary,
        screeningRationaleZh: decision.rationaleZh,
      };
    })
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  return {
    runId: candidatePayload.runId,
    fulltextCandidateCount: fulltextCandidates.length,
    reviewedCandidateCount: fulltextCandidates.length - pending.length,
    pending,
  };
}

function backlogStatus(runDirectory, closure) {
  const backlogFile = path.join(runDirectory, "fulltext", "backlog.json");
  if (!closure.pending.length) {
    return { state: "complete", count: 0, file: null, errors: [] };
  }
  if (!existsSync(backlogFile)) {
    return {
      state: "required",
      count: closure.pending.length,
      file: backlogFile,
      errors: [],
    };
  }
  const backlog = readJson(backlogFile);
  const expectedIds = closure.pending.map((item) => item.candidateId).sort();
  const recordedIds = [...(backlog.candidateIds ?? [])].sort();
  const errors = [];
  if (backlog.kind !== "paper-reading-fulltext-backlog") {
    errors.push("fulltext/backlog.json has an unsupported kind.");
  }
  if (backlog.runId !== closure.runId) errors.push("Backlog runId does not match this run.");
  if (JSON.stringify(recordedIds) !== JSON.stringify(expectedIds)) {
    errors.push("Backlog candidates do not exactly cover the unreviewed full-text candidates.");
  }
  return {
    state: errors.length ? "invalid" : "complete",
    count: recordedIds.length,
    file: backlogFile,
    errors,
  };
}

function promotionStatus(root, runDirectory, digest, fulltext) {
  if (!digest) return { state: "not-checked", acceptedCount: null, errors: [] };
  const result = validatePromotion({
    root,
    runDirectory,
    reviewDirectory: path.join(runDirectory, "fulltext", "reviews"),
    paperDirectory: "content/paper-reading/papers",
    digest,
    allowMissingReviewDirectory:
      fulltext.state === "complete" && fulltext.expectedCount === 0,
  });
  return {
    state: result.errors.length ? "invalid" : "complete",
    acceptedCount: result.acceptedCount,
    digestDate: result.digestDate,
    errors: result.errors,
  };
}

export function receiptStatus(root, runId, digest, runDirectory = null) {
  if (!digest) return { state: "not-checked", file: null, errors: [] };
  const digestPath = repositoryPath(root, digest);
  if (!existsSync(digestPath)) {
    return { state: "invalid", file: null, errors: [`Digest does not exist: ${digestPath}.`] };
  }
  const digestValue = readJson(digestPath);
  const receiptFile = path.join(
    root,
    "content",
    "paper-reading",
    "runs",
    `${digestValue.date}.json`,
  );
  if (!existsSync(receiptFile)) {
    return { state: "required", file: receiptFile, errors: [] };
  }
  const receipt = readJson(receiptFile);
  const errors = [];
  if (receipt.kind !== "paper-reading-run-receipt") {
    errors.push("Run receipt has an unsupported kind.");
  }
  if (receipt.runId !== runId) errors.push("Run receipt belongs to a different run.");
  if (receipt.digest?.sha256 !== sha256File(digestPath)) {
    errors.push("Run receipt digest hash no longer matches canonical content.");
  }
  const receiptBacklog = receipt.fulltext?.backlog;
  const backlogCandidateIds = Array.isArray(receiptBacklog?.candidateIds)
    ? receiptBacklog.candidateIds
    : null;
  if (!backlogCandidateIds) {
    errors.push("Run receipt full-text backlog must contain candidateIds.");
  } else if (backlogCandidateIds.some((candidateId) => typeof candidateId !== "string")) {
    errors.push("Run receipt full-text backlog candidateIds must be strings.");
  }
  const backlogHasFile = Boolean(receiptBacklog && Object.hasOwn(receiptBacklog, "file"));
  const backlogHasHash = Boolean(receiptBacklog && Object.hasOwn(receiptBacklog, "sha256"));
  if (backlogHasFile !== backlogHasHash) {
    errors.push("Run receipt full-text backlog must record both file and sha256 or neither.");
  }
  if (backlogCandidateIds?.length && !backlogHasFile) {
    errors.push("Run receipt non-empty full-text backlog must reference its hashed artifact.");
  }
  if (runDirectory) {
    if (backlogCandidateIds) {
      const expectedBacklogIds = fulltextClosure(runDirectory)
        .pending.map((item) => item.candidateId)
        .sort();
      const recordedBacklogIds = [...backlogCandidateIds].sort();
      if (JSON.stringify(recordedBacklogIds) !== JSON.stringify(expectedBacklogIds)) {
        errors.push("Run receipt backlog candidates no longer match full-text closure.");
      }
    }
    const recordedArtifacts = [
      receipt.discovery?.manifest,
      receipt.discovery?.candidateArtifact,
      receipt.screening?.manifest,
      receipt.screening?.decisionLedgerSnapshot,
      ...(receipt.screening?.reviews ?? []),
      ...(receipt.fulltext?.reviews ?? []),
      ...(backlogHasFile || backlogHasHash ? [receiptBacklog] : []),
      receipt.decisionLedger?.delta,
    ].filter(Boolean);
    for (const artifact of recordedArtifacts) {
      if (typeof artifact.file !== "string" || typeof artifact.sha256 !== "string") {
        errors.push("Run receipt contains an invalid local artifact record.");
        continue;
      }
      const artifactPath = repositoryPath(root, artifact.file);
      const relative = path.relative(runDirectory, artifactPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        errors.push(`Run receipt artifact escapes its run: ${artifact.file}.`);
      } else if (!existsSync(artifactPath)) {
        errors.push(`Run receipt artifact is missing: ${artifact.file}.`);
      } else if (sha256File(artifactPath) !== artifact.sha256) {
        errors.push(`Run receipt artifact hash changed: ${artifact.file}.`);
      }
    }
    if (receipt.decisionLedger?.delta) {
      const deltaFile = repositoryPath(root, receipt.decisionLedger.delta.file);
      if (existsSync(deltaFile)) {
        try {
          const delta = validateDecisionLedgerDelta(readJson(deltaFile));
          if (delta.runId !== runId) {
            errors.push("Run receipt decision-ledger delta belongs to another run.");
          }
        } catch (error) {
          errors.push(`Run receipt decision-ledger delta is invalid: ${error.message}`);
        }
      }
    }
  }
  return {
    state: errors.length ? "invalid" : "complete",
    file: receiptFile,
    errors,
  };
}

function decisionLedgerStatus(root, runId, receipt) {
  const ledgerFile = path.join(root, DEFAULT_DECISION_LEDGER_FILE);
  if (receipt.state !== "complete") {
    return { state: "pending", file: ledgerFile, errors: [] };
  }
  if (!existsSync(ledgerFile)) {
    return { state: "required", file: ledgerFile, errors: [] };
  }
  try {
    const ledger = readDecisionLedgerSync(ledgerFile);
    const imported = ledger.imports.find((entry) => entry.runId === runId);
    if (!imported) return { state: "required", file: ledgerFile, errors: [] };
    const proof = verifyDecisionLedgerImports({ ledger, root, runIds: new Set([runId]) }).find(
      (entry) => entry.runId === runId,
    );
    const errors = [...(proof?.errors ?? ["Decision ledger import proof is missing."])];
    if (!receipt.file || imported.receipt?.sha256 !== sha256File(receipt.file)) {
      errors.push("Decision ledger import no longer matches the verified run receipt.");
    }
    return {
      state: errors.length ? "invalid" : "complete",
      file: ledgerFile,
      observationCount: imported.observationCount,
      errors,
    };
  } catch (error) {
    return { state: "invalid", file: ledgerFile, errors: [error.message] };
  }
}

function finalizationStatus(discovery, receipt, decisionLedger, watermark) {
  if (receipt.state !== "complete" || decisionLedger.state !== "complete") {
    return { state: "pending", errors: [] };
  }
  if (
    watermark?.lastRunId === discovery.runId &&
    watermark?.lastSuccessfulRunAt === discovery.window?.end
  ) {
    return { state: "complete", errors: [] };
  }
  return { state: "required", errors: [] };
}

function treeSnapshot(directory, base = directory) {
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink()) throw new Error(`Cleanup refuses symbolic link: ${directory}.`);
  if (stat.isFile()) {
    return [{ path: path.relative(base, directory), bytes: stat.size, mtimeMs: stat.mtimeMs }];
  }
  if (!stat.isDirectory()) throw new Error(`Cleanup refuses non-file entry: ${directory}.`);
  return readdirSync(directory)
    .sort()
    .flatMap((name) => treeSnapshot(path.join(directory, name), base));
}

export function createWorkCleanupPlan(runDirectory) {
  const target = path.join(runDirectory, "fulltext", "work");
  if (!existsSync(target)) {
    return { target, exists: false, fileCount: 0, bytes: 0, snapshot: [] };
  }
  const expectedParent = path.join(runDirectory, "fulltext");
  if (path.dirname(target) !== expectedParent || path.basename(target) !== "work") {
    throw new Error("Cleanup target is outside the fixed fulltext/work boundary.");
  }
  const snapshot = treeSnapshot(target);
  return {
    target,
    exists: true,
    fileCount: snapshot.length,
    bytes: snapshot.reduce((sum, entry) => sum + entry.bytes, 0),
    snapshot,
  };
}

export function applyWorkCleanupPlan(plan) {
  if (!plan.exists) return { ...plan, deleted: false };
  const current = createWorkCleanupPlan(path.dirname(path.dirname(plan.target)));
  if (JSON.stringify(current.snapshot) !== JSON.stringify(plan.snapshot)) {
    throw new Error("Cleanup target changed after planning; refusing deletion.");
  }
  rmSync(plan.target, { recursive: true, force: false });
  return { ...plan, deleted: true };
}

function workStatus(runDirectory) {
  const plan = createWorkCleanupPlan(runDirectory);
  return { fileCount: plan.fileCount, bytes: plan.bytes };
}

function nextStep(stages, digest) {
  if (stages.discovery.state !== "complete") return "repair-or-complete-discovery";
  if (stages.screening.state === "pending") return "prepare-screening";
  if (stages.screening.state !== "complete") return "complete-or-repair-screening-reviews";
  if (stages.fulltext.state === "pending") return "acquire-and-review-full-text-candidates";
  if (stages.fulltext.state !== "complete") return "complete-or-repair-full-text-reviews";
  if (stages.backlog.state !== "complete") return "record-explicit-full-text-backlog";
  if (!digest) return "promote-validated-reviews-and-pass-the-digest-path";
  if (stages.promotion.state !== "complete") return "repair-canonical-promotion-or-digest";
  if (stages.receipt.state !== "complete") return "verify-and-write-the-run-receipt";
  if (stages.decisionLedger.state !== "complete") return "merge-verified-decisions-into-ledger";
  if (stages.finalization.state !== "complete") return "finalize-the-verified-run-watermark";
  return "publish-separately-then-resume-the-next-run";
}

export async function getPipelineStatus({
  root = DEFAULT_REPOSITORY_ROOT,
  runDirectory,
  selection = "all-full-text",
  digest,
}) {
  const repositoryRoot = path.resolve(root);
  const resolvedRun = resolveRunDirectory(repositoryRoot, runDirectory);
  const discovery = discoveryStatus(resolvedRun);
  const screening = await screeningStatus(repositoryRoot, resolvedRun);
  const fulltext = fulltextStatus(repositoryRoot, resolvedRun, selection, screening.state);
  let closure = { fulltextCandidateCount: 0, reviewedCandidateCount: 0, pending: [] };
  let backlog = { state: "pending", count: 0, errors: [] };
  if (screening.state === "complete") {
    closure = fulltextClosure(resolvedRun);
    backlog = backlogStatus(resolvedRun, closure);
  }
  const promotion = promotionStatus(repositoryRoot, resolvedRun, digest, fulltext);
  const stateFile = path.join(
    repositoryRoot,
    "content",
    "paper-reading",
    "state",
    "discovery-state.json",
  );
  const watermark = existsSync(stateFile) ? readJson(stateFile) : null;
  const receipt = receiptStatus(
    repositoryRoot,
    discovery.runId ?? path.basename(resolvedRun),
    digest,
    resolvedRun,
  );
  const decisionLedger = decisionLedgerStatus(
    repositoryRoot,
    discovery.runId ?? path.basename(resolvedRun),
    receipt,
  );
  const finalization = finalizationStatus(discovery, receipt, decisionLedger, watermark);
  const stages = {
    discovery,
    screening,
    fulltext,
    backlog,
    promotion,
    receipt,
    decisionLedger,
    finalization,
  };
  return {
    schemaVersion: 1,
    runId: discovery.runId ?? path.basename(resolvedRun),
    runDirectory: displayPath(repositoryRoot, resolvedRun),
    selection,
    digest: digest ? displayPath(repositoryRoot, repositoryPath(repositoryRoot, digest)) : null,
    stages,
    closure: {
      fulltextCandidateCount: closure.fulltextCandidateCount,
      reviewedCandidateCount: closure.reviewedCandidateCount,
      backlogCandidateCount: closure.pending.length,
    },
    watermark: watermark
      ? {
          lastSuccessfulRunAt: watermark.lastSuccessfulRunAt ?? null,
          lastRunId: watermark.lastRunId ?? null,
        }
      : null,
    disposableWork: workStatus(resolvedRun),
    nextStep: nextStep(stages, digest),
  };
}

function stageFailure(status, name) {
  if (status.stages[name].state === "complete") return null;
  const details = status.stages[name].errors?.join(" ") || status.stages[name].state;
  return `${name}: ${details}`;
}

function runContentValidator(root) {
  const validator = path.join(root, "scripts", "validate-paper-reading.mjs");
  const result = spawnSync(process.execPath, [validator], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `canonical-content: ${(result.stderr || result.stdout || "validation failed").trim()}`,
    );
  }
  return result.stdout.trim();
}

export async function verifyPipeline(options) {
  const status = await getPipelineStatus(options);
  const failures = ["discovery", "screening", "fulltext", "backlog", "promotion"]
    .map((name) => stageFailure(status, name))
    .filter(Boolean);
  if (failures.length) {
    throw new Error(`Pipeline verification failed:\n- ${failures.join("\n- ")}`);
  }
  const repositoryRoot = path.resolve(options.root ?? DEFAULT_REPOSITORY_ROOT);
  const canonicalContent = runContentValidator(repositoryRoot);
  return { status, canonicalContent };
}

function buildBacklogPayload(status, runDirectory) {
  const closure = fulltextClosure(runDirectory);
  return {
    schemaVersion: 1,
    kind: "paper-reading-fulltext-backlog",
    runId: closure.runId,
    generatedAt: new Date().toISOString(),
    policy: "explicit-administrative-deferral",
    reasonZh:
      "这些条目已在 abstract screening 中要求全文判断，但未进入本次明确选择的全文审阅集合；它们保留在 backlog，不能被视为 reject 或已读。",
    candidateIds: closure.pending.map((item) => item.candidateId),
    items: closure.pending,
    guarantees: {
      rejected: false,
      fulltextReviewed: false,
      silentlyDropped: false,
    },
    selection: status.selection,
  };
}

async function runBacklog(options, root, runDirectory) {
  const status = await getPipelineStatus({ ...options, root, runDirectory });
  if (status.stages.screening.state !== "complete") {
    throw new Error("Screening must validate before a backlog can be recorded.");
  }
  if (status.stages.fulltext.state !== "complete") {
    throw new Error("The selected full-text review set must validate before backlog recording.");
  }
  const output = path.join(runDirectory, "fulltext", "backlog.json");
  if (existsSync(output)) {
    if (status.stages.backlog.state !== "complete") {
      throw new Error("Existing backlog is invalid; refusing to overwrite it automatically.");
    }
    const existing = readJson(output);
    return {
      dryRun: !options.apply,
      output: displayPath(root, output),
      count: existing.candidateIds?.length ?? 0,
      candidateIds: existing.candidateIds ?? [],
      alreadyRecorded: true,
    };
  }
  const payload = buildBacklogPayload(status, runDirectory);
  if (options.apply && payload.candidateIds.length) await writeJsonAtomic(output, payload);
  return {
    dryRun: !options.apply,
    output: displayPath(root, output),
    count: payload.candidateIds.length,
    candidateIds: payload.candidateIds,
    alreadyRecorded: false,
  };
}

function hashedArtifact(root, file) {
  return {
    file: displayPath(root, file),
    sha256: sha256File(file),
  };
}

function sha256JsonPayload(value) {
  return createHash("sha256")
    .update(`${JSON.stringify(value, null, 2)}\n`)
    .digest("hex");
}

async function ensureDecisionLedgerDelta({
  root,
  runDirectory,
  apply,
  verifyAgainstRun = false,
}) {
  const output = path.join(runDirectory, "decision-ledger", "delta.json");
  let payload;
  let alreadyRecorded = false;
  if (existsSync(output)) {
    payload = validateDecisionLedgerDelta(readJson(output));
    if (verifyAgainstRun) {
      const expected = buildDecisionLedgerDelta({ root, runDirectory });
      if (canonicalJson(payload) !== canonicalJson(expected)) {
        throw new Error(
          "Unreceipted decision-ledger delta differs from current verified run artifacts.",
        );
      }
    }
    alreadyRecorded = true;
  } else {
    payload = buildDecisionLedgerDelta({ root, runDirectory });
    if (apply) await writeJsonAtomic(output, payload);
  }
  return {
    output,
    payload,
    sha256: existsSync(output) ? sha256File(output) : sha256JsonPayload(payload),
    alreadyRecorded,
  };
}

function buildRunReceipt(root, runDirectory, digest, status, deltaFile = null) {
  const digestPath = repositoryPath(root, digest);
  const digestValue = readJson(digestPath);
  const canonicalDirectory = path.join(root, "content", "paper-reading", "papers");
  const canonicalById = new Map(
    listJsonFiles(canonicalDirectory).map((file) => [readJson(file).id, file]),
  );
  const canonicalPapers = (digestValue.paperIds ?? []).map((paperId) => {
    const file = canonicalById.get(paperId);
    if (!file) throw new Error(`Cannot build receipt: canonical paper '${paperId}' is missing.`);
    return { paperId, ...hashedArtifact(root, file) };
  });
  const screeningReviews = listJsonFiles(
    path.join(runDirectory, "screening", "reviews"),
    (name) => name.endsWith(".review.json"),
  ).map((file) => hashedArtifact(root, file));
  const fulltextReviews = listJsonFiles(
    path.join(runDirectory, "fulltext", "reviews"),
    (name) => name !== "summary.json",
  ).map((file) => {
    const review = readJson(file);
    return {
      paperId: review.paperId,
      arxivVersion: review.arxivVersion,
      decision: review.decision,
      ...hashedArtifact(root, file),
    };
  });
  let backlogRecord = { candidateIds: [] };
  if (status.closure.backlogCandidateCount > 0) {
    const backlogFile = path.join(runDirectory, "fulltext", "backlog.json");
    const backlog = readJson(backlogFile);
    backlogRecord = {
      candidateIds: backlog.candidateIds,
      ...hashedArtifact(root, backlogFile),
    };
  }
  const manifest = readJson(path.join(runDirectory, "manifest.json"));
  const screeningManifest = readJson(
    path.join(runDirectory, "screening", "screening-manifest.json"),
  );
  const snapshotRecord = screeningManifest.sourceInputs?.decisionLedgerSnapshot;
  const snapshotFile = snapshotRecord?.file
    ? repositoryPath(runDirectory, snapshotRecord.file)
    : null;
  return {
    schemaVersion: 1,
    kind: "paper-reading-run-receipt",
    runId: status.runId,
    digestDate: digestValue.date,
    generatedAt: new Date().toISOString(),
    status: "content-verified",
    selection: status.selection,
    discovery: {
      window: manifest.window,
      sources: status.stages.discovery.sourceStatuses,
      candidates: status.stages.discovery.candidateCount,
      manifest: hashedArtifact(root, path.join(runDirectory, "manifest.json")),
      candidateArtifact: hashedArtifact(root, path.join(runDirectory, "candidates.json")),
    },
    screening: {
      discoveredCandidates:
        status.stages.screening.discoveredCandidateCount ??
        status.stages.discovery.candidateCount,
      reviewedCandidates: status.stages.screening.candidateCount,
      ledgerSkippedCandidates: status.stages.screening.ledgerSkippedCandidateCount ?? 0,
      decisions: status.stages.screening.decisionCounts,
      manifest: hashedArtifact(
        root,
        path.join(runDirectory, "screening", "screening-manifest.json"),
      ),
      ...(snapshotFile && existsSync(snapshotFile)
        ? { decisionLedgerSnapshot: hashedArtifact(root, snapshotFile) }
        : {}),
      reviews: screeningReviews,
    },
    fulltext: {
      decisions: status.stages.fulltext.decisionCounts,
      reviews: fulltextReviews,
      backlog: backlogRecord,
    },
    digest: hashedArtifact(root, digestPath),
    canonicalPapers,
    ...(deltaFile
      ? {
          decisionLedger: {
            aggregateIsMutableAndNotReceiptPinned: true,
            delta: hashedArtifact(root, deltaFile),
          },
        }
      : {}),
    publication: {
      handledSeparately: true,
      recordedAsPublished: false,
    },
    watermark: {
      advancedByReceipt: false,
      previousLastSuccessfulRunAt:
        status.stages.discovery.window?.lastSuccessfulRunAt ??
        status.watermark?.lastSuccessfulRunAt ??
        null,
    },
  };
}

export async function runReceipt(options, root, runDirectory) {
  const verification = await verifyPipeline({ ...options, root, runDirectory });
  const digestPath = repositoryPath(root, options.digest);
  const digest = readJson(digestPath);
  const output = path.join(root, "content", "paper-reading", "runs", `${digest.date}.json`);
  if (existsSync(output)) {
    const existingStatus = receiptStatus(
      root,
      verification.status.runId,
      options.digest,
      runDirectory,
    );
    if (existingStatus.state !== "complete") {
      throw new Error("Existing run receipt is invalid; refusing to overwrite it automatically.");
    }
    return {
      dryRun: !options.apply,
      output: displayPath(root, output),
      alreadyRecorded: true,
    };
  }
  const delta = await ensureDecisionLedgerDelta({
    root,
    runDirectory,
    apply: Boolean(options.apply),
    verifyAgainstRun: true,
  });
  const payload = buildRunReceipt(
    root,
    runDirectory,
    options.digest,
    verification.status,
    options.apply || delta.alreadyRecorded ? delta.output : null,
  );
  if (options.apply) await writeJsonAtomic(output, payload);
  return {
    dryRun: !options.apply,
    output: displayPath(root, output),
    paperCount: payload.canonicalPapers.length,
    screeningReviewCount: payload.screening.reviews.length,
    fulltextReviewCount: payload.fulltext.reviews.length,
    backlogCount: payload.fulltext.backlog.candidateIds.length,
    decisionLedgerObservationCount: delta.payload.counts.observations,
    decisionLedgerDelta: displayPath(root, delta.output),
    alreadyRecorded: false,
  };
}

async function mergeVerifiedRunDecisions({
  options,
  root,
  runDirectory,
  verification,
  receipt,
}) {
  const receiptValue = readJson(receipt.file);
  const delta = await ensureDecisionLedgerDelta({
    root,
    runDirectory,
    apply: Boolean(options.apply),
    verifyAgainstRun: !receiptValue.decisionLedger?.delta,
  });
  if (
    !receiptValue.decisionLedger?.delta &&
    !LEGACY_DECISION_LEDGER_RUN_IDS.has(verification.status.runId)
  ) {
    throw new Error(
      "This non-legacy run receipt does not pin a decision-ledger delta; refusing import.",
    );
  }
  if (receiptValue.decisionLedger?.delta) {
    const pinnedDelta = receiptValue.decisionLedger.delta;
    if (
      repositoryPath(root, pinnedDelta.file) !== delta.output ||
      pinnedDelta.sha256 !== delta.sha256
    ) {
      throw new Error("Verified receipt pins a different decision-ledger delta.");
    }
  }
  const ledgerFile = path.join(root, DEFAULT_DECISION_LEDGER_FILE);
  const current = readDecisionLedgerSync(ledgerFile);
  const next = mergeDecisionLedger({
    ledger: current,
    delta: delta.payload,
    deltaArtifact: {
      file: displayPath(root, delta.output),
      sha256: delta.sha256,
    },
    receiptArtifact: hashedArtifact(root, receipt.file),
  });
  const alreadyImported = canonicalJson(current) === canonicalJson(next);
  if (options.apply && !alreadyImported) {
    if (!existsSync(delta.output)) {
      throw new Error("Decision-ledger delta must be written before aggregate merge.");
    }
    await writeJsonAtomic(ledgerFile, next);
    const written = readDecisionLedgerSync(ledgerFile);
    if (canonicalJson(written) !== canonicalJson(next)) {
      throw new Error("Decision ledger failed post-write verification.");
    }
  }
  return {
    dryRun: !options.apply,
    ledgerFile: displayPath(root, ledgerFile),
    deltaFile: displayPath(root, delta.output),
    receiptFile: displayPath(root, receipt.file),
    runId: verification.status.runId,
    observationCount: delta.payload.counts.observations,
    terminalObservationCount: delta.payload.counts.terminal,
    alreadyImported,
    summary: next.summary,
  };
}

export async function runLedger(options, root, runDirectory) {
  const verification = await verifyPipeline({ ...options, root, runDirectory });
  const receipt = receiptStatus(
    root,
    verification.status.runId,
    options.digest,
    runDirectory,
  );
  if (receipt.state !== "complete") {
    throw new Error("A valid checked-in run receipt is required before ledger import.");
  }
  return mergeVerifiedRunDecisions({
    options,
    root,
    runDirectory,
    verification,
    receipt,
  });
}

export async function runFinalize(options, root, runDirectory) {
  const verification = await verifyPipeline({ ...options, root, runDirectory });
  const status = verification.status;
  const receipt = receiptStatus(root, status.runId, options.digest, runDirectory);
  if (receipt.state !== "complete") {
    throw new Error("A valid checked-in run receipt is required before finalization.");
  }
  const stateFile = path.join(
    root,
    "content",
    "paper-reading",
    "state",
    "discovery-state.json",
  );
  const current = readJson(stateFile);
  if (current.schemaVersion !== 1) {
    throw new Error("Discovery state schemaVersion must be 1.");
  }
  const windowEnd = status.stages.discovery.window?.end;
  if (!windowEnd) throw new Error("Discovery manifest does not contain a window end.");
  if (
    current.lastSuccessfulRunAt &&
    Date.parse(current.lastSuccessfulRunAt) > Date.parse(windowEnd) &&
    current.lastRunId !== status.runId
  ) {
    throw new Error("Refusing to move the discovery watermark backwards from a newer run.");
  }
  const ledger = await mergeVerifiedRunDecisions({
    options,
    root,
    runDirectory,
    verification,
    receipt,
  });
  const next = {
    ...current,
    schemaVersion: 1,
    lastSuccessfulRunAt: windowEnd,
    lastRunId: status.runId,
    lastManifestPath: displayPath(root, path.join(runDirectory, "manifest.json")),
    overlapHours: status.stages.discovery.window?.overlapHours ?? current.overlapHours ?? 48,
    lastDigestPath: displayPath(root, repositoryPath(root, options.digest)),
    lastReceiptPath: displayPath(root, receipt.file),
    updatedAt: new Date().toISOString(),
    noteZh:
      "watermark 只在 screening、全文审阅/backlog、promotion、canonical schema 与 run receipt 全部验证后推进；发布仍是独立授权步骤。",
  };
  const alreadyFinalized =
    ledger.alreadyImported &&
    current.lastSuccessfulRunAt === next.lastSuccessfulRunAt &&
    current.lastRunId === next.lastRunId &&
    current.lastReceiptPath === next.lastReceiptPath;
  if (options.apply && !alreadyFinalized) await writeJsonAtomic(stateFile, next);
  return {
    dryRun: !options.apply,
    stateFile: displayPath(root, stateFile),
    decisionLedger: ledger,
    alreadyFinalized,
    before: {
      lastSuccessfulRunAt: current.lastSuccessfulRunAt ?? null,
      lastRunId: current.lastRunId ?? null,
    },
    after: {
      lastSuccessfulRunAt: next.lastSuccessfulRunAt,
      lastRunId: next.lastRunId,
    },
  };
}

async function runCleanup(options, root, runDirectory) {
  const status = await getPipelineStatus({ ...options, root, runDirectory });
  for (const name of ["screening", "fulltext", "backlog"]) {
    const failure = stageFailure(status, name);
    if (failure) throw new Error(`Cleanup refused because ${failure}`);
  }
  if (options.digest && status.stages.promotion.state !== "complete") {
    throw new Error("Cleanup refused because promotion validation did not pass.");
  }
  const plan = createWorkCleanupPlan(runDirectory);
  const result = options.apply ? applyWorkCleanupPlan(plan) : { ...plan, deleted: false };
  return {
    dryRun: !options.apply,
    target: displayPath(root, result.target),
    existed: result.exists,
    deleted: result.deleted,
    fileCount: result.fileCount,
    bytes: result.bytes,
  };
}

function printStatus(status) {
  process.stdout.write(`[paper-reading] run ${status.runId}\n`);
  for (const [name, stage] of Object.entries(status.stages)) {
    const count =
      stage.candidateCount ??
      stage.reviewCount ??
      stage.observationCount ??
      stage.acceptedCount ??
      stage.count ??
      null;
    process.stdout.write(
      `[paper-reading] ${name}: ${stage.state}${count === null ? "" : ` (${count})`}\n`,
    );
  }
  process.stdout.write(
    `[paper-reading] full-text closure: ${status.closure.reviewedCandidateCount} reviewed, ${status.closure.backlogCandidateCount} backlog\n`,
  );
  process.stdout.write(`[paper-reading] next: ${status.nextStep}\n`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "help" || options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const root = DEFAULT_REPOSITORY_ROOT;
  const runDirectory = resolveRunDirectory(root, options.runDirectory);
  let result;
  if (options.command === "status") {
    result = await getPipelineStatus({ ...options, root, runDirectory });
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else printStatus(result);
    return;
  }
  if (options.command === "verify") result = await verifyPipeline({ ...options, root, runDirectory });
  else if (options.command === "backlog") result = await runBacklog(options, root, runDirectory);
  else if (options.command === "receipt") result = await runReceipt(options, root, runDirectory);
  else if (options.command === "ledger") result = await runLedger(options, root, runDirectory);
  else if (options.command === "finalize") result = await runFinalize(options, root, runDirectory);
  else result = await runCleanup(options, root, runDirectory);
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    const action = options.command === "verify" ? "verified" : options.command;
    process.stdout.write(`[paper-reading] ${action}: ${JSON.stringify(result)}\n`);
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`[paper-reading] ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
