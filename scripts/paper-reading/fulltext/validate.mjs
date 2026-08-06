#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  ACCEPT_DECISIONS,
  CODE_STATUSES,
  CONFIDENCE_LEVELS,
  EVIDENCE_SUPPORT,
  FULLTEXT_DECISIONS,
  FULLTEXT_SCHEMA_VERSION,
  READING_ACTIONS,
  RELEVANCE_LEVELS,
} from "./contract.mjs";

const allowed = {
  decisions: new Set(FULLTEXT_DECISIONS),
  relevance: new Set(RELEVANCE_LEVELS),
  readingActions: new Set(READING_ACTIONS),
  confidence: new Set(CONFIDENCE_LEVELS),
  evidenceSupport: new Set(EVIDENCE_SUPPORT),
  codeStatuses: new Set(CODE_STATUSES),
};

function parseArguments(argv) {
  const options = {
    researchConfig: "content/paper-reading/research-config.json",
    selection: "all-full-text",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${argument} requires a value.`);
      return argv[index];
    };
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--run-dir") options.runDirectory = next();
    else if (argument === "--reviews-dir") {
      options.reviewDirectory = next();
      options.reviewDirectoryExplicit = true;
    }
    else if (argument === "--research-config") options.researchConfig = next();
    else if (argument === "--screening-run-dir") options.screeningRunDirectory = next();
    else if (argument === "--selection") options.selection = next();
    else if (argument === "--expected-count") options.expectedCount = Number(next());
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!new Set(["high-deep", "all-full-text"]).has(options.selection)) {
    throw new Error("--selection must be 'high-deep' or 'all-full-text'.");
  }
  if (options.expectedCount !== undefined && !Number.isInteger(options.expectedCount)) {
    throw new Error("--expected-count must be an integer.");
  }
  if (options.runDirectory) {
    if (options.reviewDirectoryExplicit || options.screeningRunDirectory) {
      throw new Error("Use --run-dir by itself instead of combining it with review/screening paths.");
    }
    options.reviewDirectory = path.join(options.runDirectory, "fulltext", "reviews");
    options.screeningRunDirectory = options.runDirectory;
  }
  if (!options.help && !options.reviewDirectory) {
    throw new Error("--run-dir <directory> is required.");
  }
  return options;
}

function helpText() {
  return `Validate Paper Reading full-text reviews

Usage:
  npm run validate:paper-fulltext -- [options]

Options:
  --run-dir <directory>           Derive screening and full-text paths from one run directory.
  --reviews-dir <directory>       Backward-compatible explicit review directory.
  --research-config <file>        Default: content/paper-reading/research-config.json
  --screening-run-dir <directory> Join reviews to the preceding screening decisions.
  --selection <mode>              all-full-text (default) or explicit high-deep backlog split.
  --expected-count <number>       Require an exact number of review documents.
  --help                          Show this help.

This command is read-only. It verifies review structure, configured topic IDs, immutable PDF
hashes and page counts, visual-inspection coverage, and optional screening-stage completeness.`;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

function getPdfPageCount(filePath) {
  const output = execFileSync("pdfinfo", [filePath], { encoding: "utf8" });
  const match = output.match(/^Pages:\s+(\d+)$/m);
  if (!match) throw new Error(`pdfinfo did not report a page count for ${filePath}.`);
  return Number(match[1]);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, label, errors) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object.`);
    return false;
  }
  return true;
}

function requireText(value, label, errors) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${label} must be a non-empty string.`);
    return false;
  }
  return true;
}

function requireEnum(value, values, label, errors) {
  if (!values.has(value)) {
    errors.push(`${label} must be one of: ${[...values].join(", ")}.`);
    return false;
  }
  return true;
}

function requireTextArray(value, label, errors, { minimum = 0 } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array.`);
    return [];
  }
  if (value.length < minimum) errors.push(`${label} must contain at least ${minimum} item(s).`);
  value.forEach((item, index) => requireText(item, `${label}[${index}]`, errors));
  return value;
}

function validateFigure(value, label, inspectedPages, pageCount, errors) {
  if (value === null) return;
  if (!requireObject(value, label, errors)) return;
  if (!Number.isInteger(value.page) || value.page < 1 || value.page > pageCount) {
    errors.push(`${label}.page must be an integer inside the PDF page range.`);
  } else if (!inspectedPages.has(value.page)) {
    errors.push(`${label}.page ${value.page} must appear in source.visuallyInspectedPages.`);
  }
  requireText(value.label, `${label}.label`, errors);
  requireText(value.reasonZh, `${label}.reasonZh`, errors);
}

function configuredTopicIds(config) {
  const topics = Array.isArray(config.directions)
    ? config.directions
    : Array.isArray(config.topics)
      ? config.topics
      : [];
  return new Set(topics.map((topic) => topic.id).filter(Boolean));
}

function resolveFrom(root, value) {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function collectExpectedPaperIds(root, screeningRunDirectory, selection, errors) {
  const runDirectory = resolveFrom(root, screeningRunDirectory);
  const candidatesPath = path.join(runDirectory, "candidates.json");
  const reviewsDirectory = path.join(runDirectory, "screening", "reviews");
  if (!existsSync(candidatesPath) || !existsSync(reviewsDirectory)) {
    errors.push(`${runDirectory} must contain candidates.json and screening/reviews/.`);
    return { expectedByPaperId: new Map(), runId: null };
  }

  const candidatePayload = readJson(candidatesPath);
  const candidates = candidatePayload.candidates ?? [];
  const candidateById = new Map(
    candidates.map((candidate) => [candidate.discoveryId ?? candidate.candidateId, candidate]),
  );
  const expectedByPaperId = new Map();
  const reviewFiles = readdirSync(reviewsDirectory)
    .filter((name) => name.endsWith(".review.json"))
    .sort();

  for (const reviewFile of reviewFiles) {
    const review = readJson(path.join(reviewsDirectory, reviewFile));
    for (const decision of review.decisions ?? []) {
      if (decision.decision !== "full-text-review") continue;
      if (
        selection === "high-deep" &&
        (decision.preliminary?.relevance !== "high" || decision.preliminary?.readingAction !== "deep")
      ) {
        continue;
      }
      const candidate = candidateById.get(decision.candidateId);
      if (!candidate) {
        errors.push(`Screening decision references missing candidate '${decision.candidateId}'.`);
        continue;
      }
      const arxivIds = candidate.identifiers?.arxiv ?? [];
      if (arxivIds.length !== 1) {
        errors.push(`Expected candidate '${decision.candidateId}' to have exactly one arXiv ID.`);
        continue;
      }
      const paperId = `arxiv:${arxivIds[0].replace(/v\d+$/, "")}`;
      if (expectedByPaperId.has(paperId)) {
        errors.push(`Multiple screening candidates resolve to '${paperId}'.`);
      }
      expectedByPaperId.set(paperId, candidate.discoveryId ?? candidate.candidateId);
    }
  }
  return { expectedByPaperId, runId: candidatePayload.runId ?? null };
}

function validateReview(review, filePath, topicIds, root, errors) {
  const label = path.basename(filePath);
  if (!requireObject(review, label, errors)) return;
  if (review.schemaVersion !== FULLTEXT_SCHEMA_VERSION) {
    errors.push(`${label}.schemaVersion must be ${FULLTEXT_SCHEMA_VERSION}.`);
  }
  if (review.kind !== "paper-reading-fulltext-review") {
    errors.push(`${label}.kind must be 'paper-reading-fulltext-review'.`);
  }
  requireText(review.runId, `${label}.runId`, errors);
  requireText(review.candidateId, `${label}.candidateId`, errors);
  requireText(review.paperId, `${label}.paperId`, errors);
  requireText(review.arxivVersion, `${label}.arxivVersion`, errors);
  requireText(review.title, `${label}.title`, errors);
  if (typeof review.reviewedAt !== "string" || Number.isNaN(Date.parse(review.reviewedAt))) {
    errors.push(`${label}.reviewedAt must be an ISO date-time.`);
  }
  if (!/^\d{4}\.\d{4,5}v\d+$/.test(review.arxivVersion ?? "")) {
    errors.push(`${label}.arxivVersion must be a versioned arXiv ID.`);
  } else {
    const versionlessId = review.arxivVersion.replace(/v\d+$/, "");
    if (review.paperId !== `arxiv:${versionlessId}`) {
      errors.push(`${label}.paperId must match versionless arxivVersion.`);
    }
    if (path.basename(filePath) !== `${review.arxivVersion}.json`) {
      errors.push(`${label} filename must match arxivVersion.`);
    }
  }

  if (requireObject(review.reviewer, `${label}.reviewer`, errors)) {
    if (review.reviewer.kind !== "ai" && review.reviewer.kind !== "human") {
      errors.push(`${label}.reviewer.kind must be 'ai' or 'human'.`);
    }
    requireText(review.reviewer.name, `${label}.reviewer.name`, errors);
    if (review.reviewer.kind === "ai") requireText(review.reviewer.model, `${label}.reviewer.model`, errors);
  }

  const decisionValid = requireEnum(review.decision, allowed.decisions, `${label}.decision`, errors);
  requireEnum(review.relevance, allowed.relevance, `${label}.relevance`, errors);
  requireEnum(review.readingAction, allowed.readingActions, `${label}.readingAction`, errors);
  requireEnum(review.confidence, allowed.confidence, `${label}.confidence`, errors);
  if (review.decision === "accept-deep" && review.readingAction !== "deep") {
    errors.push(`${label}.readingAction must be 'deep' for accept-deep.`);
  }
  if (review.decision === "accept-skim" && review.readingAction !== "skim") {
    errors.push(`${label}.readingAction must be 'skim' for accept-skim.`);
  }

  if (!topicIds.has(review.primaryTopicId)) {
    errors.push(`${label}.primaryTopicId must be a configured topic ID.`);
  }
  const secondaryTopicIds = requireTextArray(
    review.secondaryTopicIds,
    `${label}.secondaryTopicIds`,
    errors,
  );
  const seenSecondary = new Set();
  for (const topicId of secondaryTopicIds) {
    if (!topicIds.has(topicId)) errors.push(`${label} has unknown secondary topic '${topicId}'.`);
    if (topicId === review.primaryTopicId) errors.push(`${label} repeats primaryTopicId in secondaryTopicIds.`);
    if (seenSecondary.has(topicId)) errors.push(`${label} has duplicate secondary topic '${topicId}'.`);
    seenSecondary.add(topicId);
  }

  [
    [review.thirtySecondZh, "thirtySecondZh"],
    [review.descriptiveSummaryZh, "descriptiveSummaryZh"],
    [review.noveltyAssessmentZh, "noveltyAssessmentZh"],
    [review.whyRelevantZh, "whyRelevantZh"],
    [review.decisionRationaleZh, "decisionRationaleZh"],
  ].forEach(([value, field]) => requireText(value, `${label}.${field}`, errors));
  const methodFlow = requireTextArray(review.methodFlow, `${label}.methodFlow`, errors, {
    minimum: ACCEPT_DECISIONS.has(review.decision) ? 2 : 0,
  });
  if (methodFlow.length > 6) errors.push(`${label}.methodFlow must contain at most 6 steps.`);

  let inspectedPages = new Set();
  let pageCount = 0;
  if (requireObject(review.source, `${label}.source`, errors)) {
    if (review.source.scope !== "full_text") errors.push(`${label}.source.scope must be 'full_text'.`);
    if (review.source.textExtraction !== "pdftotext-layout") {
      errors.push(`${label}.source.textExtraction must be 'pdftotext-layout'.`);
    }
    requireText(review.source.pdfPath, `${label}.source.pdfPath`, errors);
    requireText(review.source.pdfSha256, `${label}.source.pdfSha256`, errors);
    pageCount = review.source.pageCount;
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      errors.push(`${label}.source.pageCount must be a positive integer.`);
      pageCount = 0;
    }
    const pages = review.source.visuallyInspectedPages;
    if (!Array.isArray(pages)) {
      errors.push(`${label}.source.visuallyInspectedPages must be an array.`);
    } else {
      inspectedPages = new Set(pages);
      if (inspectedPages.size !== pages.length) errors.push(`${label} has duplicate visually inspected pages.`);
      for (const page of pages) {
        if (!Number.isInteger(page) || page < 1 || page > pageCount) {
          errors.push(`${label} has an inspected page outside the PDF page range.`);
        }
      }
      if (!inspectedPages.has(1)) errors.push(`${label} must visually inspect the first page.`);
      if (ACCEPT_DECISIONS.has(review.decision) && pages.length < 4) {
        errors.push(`${label} accept decisions must visually inspect at least four relevant pages.`);
      }
    }

    if (typeof review.source.pdfPath === "string") {
      const pdfPath = resolveFrom(root, review.source.pdfPath);
      if (!existsSync(pdfPath)) {
        errors.push(`${label} PDF does not exist at '${review.source.pdfPath}'.`);
      } else {
        if (sha256File(pdfPath) !== review.source.pdfSha256) {
          errors.push(`${label} PDF sha256 does not match.`);
        }
        try {
          if (getPdfPageCount(pdfPath) !== review.source.pageCount) {
            errors.push(`${label} PDF page count does not match source.pageCount.`);
          }
        } catch (error) {
          errors.push(`${label} could not verify PDF page count: ${error.message}`);
        }
      }
    }
  }

  const evidence = Array.isArray(review.evidence) ? review.evidence : [];
  if (!Array.isArray(review.evidence)) errors.push(`${label}.evidence must be an array.`);
  if (ACCEPT_DECISIONS.has(review.decision) && evidence.length < 3) {
    errors.push(`${label} accept decisions need at least three evidence items.`);
  }
  evidence.forEach((item, index) => {
    const itemLabel = `${label}.evidence[${index}]`;
    if (!requireObject(item, itemLabel, errors)) return;
    requireText(item.claimZh, `${itemLabel}.claimZh`, errors);
    requireText(item.locator, `${itemLabel}.locator`, errors);
    requireText(item.noteZh, `${itemLabel}.noteZh`, errors);
    requireEnum(item.support, allowed.evidenceSupport, `${itemLabel}.support`, errors);
  });

  if (requireObject(review.experiments, `${label}.experiments`, errors)) {
    requireText(review.experiments.setupZh, `${label}.experiments.setupZh`, errors);
    requireText(review.experiments.baselineCoverageZh, `${label}.experiments.baselineCoverageZh`, errors);
    requireText(review.experiments.ablationZh, `${label}.experiments.ablationZh`, errors);
    const results = review.experiments.keyResults;
    if (!Array.isArray(results)) {
      errors.push(`${label}.experiments.keyResults must be an array.`);
    } else {
      if (ACCEPT_DECISIONS.has(review.decision) && results.length === 0) {
        errors.push(`${label} accept decisions need at least one located key result.`);
      }
      results.forEach((result, index) => {
        if (!requireObject(result, `${label}.experiments.keyResults[${index}]`, errors)) return;
        requireText(result.resultZh, `${label}.experiments.keyResults[${index}].resultZh`, errors);
        requireText(result.locator, `${label}.experiments.keyResults[${index}].locator`, errors);
      });
    }
  }

  if (requireObject(review.limitations, `${label}.limitations`, errors)) {
    requireTextArray(review.limitations.authorsZh, `${label}.limitations.authorsZh`, errors);
    requireTextArray(review.limitations.reviewerRisksZh, `${label}.limitations.reviewerRisksZh`, errors, {
      minimum: ACCEPT_DECISIONS.has(review.decision) ? 1 : 0,
    });
  }

  if (requireObject(review.code, `${label}.code`, errors)) {
    const statusValid = requireEnum(review.code.status, allowed.codeStatuses, `${label}.code.status`, errors);
    if (statusValid && review.code.status === "available") {
      if (typeof review.code.url !== "string" || !/^https?:\/\//.test(review.code.url)) {
        errors.push(`${label}.code.url must be an HTTP(S) URL when code is available.`);
      }
    } else if (review.code.url !== null) {
      errors.push(`${label}.code.url must be null unless code is available.`);
    }
  }

  if (requireObject(review.visuals, `${label}.visuals`, errors)) {
    if (ACCEPT_DECISIONS.has(review.decision) && review.visuals.methodFigure === null) {
      errors.push(`${label} accept decisions require a methodFigure.`);
    }
    validateFigure(review.visuals.methodFigure, `${label}.visuals.methodFigure`, inspectedPages, pageCount, errors);
    validateFigure(review.visuals.conceptFigure, `${label}.visuals.conceptFigure`, inspectedPages, pageCount, errors);
  }

  return decisionValid
    ? { paperId: review.paperId, candidateId: review.candidateId, runId: review.runId }
    : null;
}

export function validateFulltextReviews(options) {
  const errors = [];
  const root = path.resolve(options.root ?? process.cwd());
  const reviewDirectory = resolveFrom(root, options.reviewDirectory);
  const researchConfigPath = resolveFrom(root, options.researchConfig);
  if (!existsSync(reviewDirectory)) errors.push(`Review directory does not exist: ${reviewDirectory}.`);
  if (!existsSync(researchConfigPath)) errors.push(`Research config does not exist: ${researchConfigPath}.`);
  if (errors.length) return { errors, reviews: [], counts: {} };

  const topicIds = configuredTopicIds(readJson(researchConfigPath));
  const reviewFiles = readdirSync(reviewDirectory)
    .filter((name) => name.endsWith(".json") && name !== "summary.json")
    .sort()
    .map((name) => path.join(reviewDirectory, name));
  if (options.expectedCount !== undefined && reviewFiles.length !== options.expectedCount) {
    errors.push(`Expected ${options.expectedCount} review documents, found ${reviewFiles.length}.`);
  }

  const reviews = [];
  const paperIds = new Set();
  const reviewMetadataByPaperId = new Map();
  for (const reviewFile of reviewFiles) {
    let review;
    try {
      review = readJson(reviewFile);
    } catch (error) {
      errors.push(`${path.basename(reviewFile)} is not valid JSON: ${error.message}`);
      continue;
    }
    reviews.push(review);
    const metadata = validateReview(review, reviewFile, topicIds, root, errors);
    if (metadata) {
      if (paperIds.has(metadata.paperId)) {
        errors.push(`Duplicate full-text review for '${metadata.paperId}'.`);
      }
      paperIds.add(metadata.paperId);
      reviewMetadataByPaperId.set(metadata.paperId, metadata);
    }
  }

  let expectedByPaperId = null;
  if (options.screeningRunDirectory) {
    const expected = collectExpectedPaperIds(
      root,
      options.screeningRunDirectory,
      options.selection,
      errors,
    );
    expectedByPaperId = expected.expectedByPaperId;
    for (const [expectedId, candidateId] of expectedByPaperId) {
      const metadata = reviewMetadataByPaperId.get(expectedId);
      if (!metadata) {
        errors.push(`Missing full-text review for '${expectedId}'.`);
        continue;
      }
      if (metadata.candidateId !== candidateId) {
        errors.push(
          `Full-text review '${expectedId}' belongs to '${metadata.candidateId}', expected '${candidateId}'.`,
        );
      }
      if (expected.runId && metadata.runId !== expected.runId) {
        errors.push(
          `Full-text review '${expectedId}' belongs to run '${metadata.runId}', expected '${expected.runId}'.`,
        );
      }
    }
    for (const paperId of paperIds) {
      if (!expectedByPaperId.has(paperId)) {
        errors.push(`Unexpected full-text review '${paperId}' for selection '${options.selection}'.`);
      }
    }
  }

  const byDecision = Object.fromEntries(FULLTEXT_DECISIONS.map((decision) => [decision, 0]));
  const byTopic = {};
  for (const review of reviews) {
    if (Object.hasOwn(byDecision, review.decision)) byDecision[review.decision] += 1;
    if (typeof review.primaryTopicId === "string") {
      byTopic[review.primaryTopicId] = (byTopic[review.primaryTopicId] ?? 0) + 1;
    }
  }
  return {
    errors,
    reviews,
    counts: {
      total: reviews.length,
      expected: expectedByPaperId?.size ?? null,
      byDecision,
      byTopic,
    },
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const result = validateFulltextReviews(options);
  if (result.errors.length) {
    process.stderr.write(`Full-text review validation failed (${result.errors.length} error(s)):\n`);
    result.errors.forEach((error) => process.stderr.write(`- ${error}\n`));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(result.counts, null, 2)}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
