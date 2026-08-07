#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function parseArguments(argv) {
  const options = {
    paperDirectory: "content/paper-reading/papers",
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
    else if (argument === "--papers-dir") options.paperDirectory = next();
    else if (argument === "--digest") options.digest = next();
    else if (argument === "--expected-count") options.expectedCount = Number(next());
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.help && !options.digest) {
    throw new Error("--digest <content digest JSON> is required.");
  }
  if (!options.help && !options.runDirectory && !options.reviewDirectoryExplicit) {
    throw new Error("--run-dir <directory> is required.");
  }
  if (
    options.expectedCount !== undefined &&
    (!Number.isInteger(options.expectedCount) || options.expectedCount < 0)
  ) {
    throw new Error("--expected-count must be a non-negative integer.");
  }
  if (options.runDirectory) {
    if (options.reviewDirectoryExplicit) {
      throw new Error("Use either --run-dir or --reviews-dir, not both.");
    }
    options.reviewDirectory = path.join(options.runDirectory, "fulltext", "reviews");
  }
  return options;
}

function helpText() {
  return `Validate promotion from one Paper Reading run

Usage:
  npm run validate:paper-promotion -- --run-dir <run-directory> --digest <digest.json>

Options:
  --run-dir <directory>      Derive full-text reviews from <run-dir>/fulltext/reviews.
  --reviews-dir <directory>  Backward-compatible explicit review directory.
  --papers-dir <directory>   Default: content/paper-reading/papers.
  --digest <file>            Required canonical digest JSON.
  --expected-count <number>  Require an exact accepted-review count; use 0 for a verified empty run.
  --help                     Show this help.

This command is read-only. It joins accepted full-text reviews to canonical paper records and
the selected digest; it does not write content, build, commit, push, or publish.`;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function readJsonDirectory(directory, { exclude = [] } = {}) {
  const excluded = new Set(exclude);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json") && !excluded.has(name))
    .sort()
    .map((name) => ({ file: path.join(directory, name), value: readJson(path.join(directory, name)) }));
}

export function validatePromotion(options) {
  if (!options?.digest) throw new Error("A digest path is required.");
  if (!options.reviewDirectory) throw new Error("A full-text review directory is required.");
  const root = path.resolve(options.root ?? process.cwd());
  const resolveFromRoot = (value) => path.isAbsolute(value) ? value : path.resolve(root, value);
  const reviewDirectory = resolveFromRoot(options.reviewDirectory);
  const runDirectory = options.runDirectory
    ? resolveFromRoot(options.runDirectory)
    : null;
  const paperDirectory = resolveFromRoot(options.paperDirectory);
  const digestPath = resolveFromRoot(options.digest);
  const candidatesPath = runDirectory
    ? path.join(runDirectory, "candidates.json")
    : null;
  const errors = [];
  const reviewDirectoryExists = existsSync(reviewDirectory);
  const missingReviewDirectoryAllowed =
    options.allowMissingReviewDirectory || options.expectedCount === 0;
  if (!reviewDirectoryExists && !missingReviewDirectoryAllowed) {
    errors.push(`Review directory does not exist: ${reviewDirectory}.`);
  }
  if (!existsSync(paperDirectory)) {
    errors.push(`Canonical paper directory does not exist: ${paperDirectory}.`);
  }
  if (!existsSync(digestPath)) errors.push(`Digest does not exist: ${digestPath}.`);
  if (candidatesPath && !existsSync(candidatesPath)) {
    errors.push(`Run candidates do not exist: ${candidatesPath}.`);
  }
  if (errors.length) return { errors, acceptedCount: 0, digestDate: null };

  const reviewEntries = reviewDirectoryExists
    ? readJsonDirectory(reviewDirectory, { exclude: ["summary.json"] })
    : [];
  const paperEntries = readJsonDirectory(paperDirectory);
  const digest = readJson(digestPath);
  const candidates = candidatesPath ? readJson(candidatesPath).candidates ?? [] : [];
  const candidateByArxivId = new Map();
  for (const candidate of candidates) {
    for (const arxivId of candidate.identifiers?.arxiv ?? []) {
      candidateByArxivId.set(arxivId.replace(/v\d+$/, ""), candidate);
    }
  }

  const acceptedReviews = reviewEntries
    .map(({ value }) => value)
    .filter((review) => review.decision === "accept-deep" || review.decision === "accept-skim");
  if (
    options.expectedCount !== undefined &&
    acceptedReviews.length !== options.expectedCount
  ) {
    errors.push(
      `Expected ${options.expectedCount} accepted full-text reviews, found ${acceptedReviews.length}.`,
    );
  }
  const reviewsByPaperId = new Map(acceptedReviews.map((review) => [review.paperId, review]));
  const papersById = new Map(paperEntries.map(({ value }) => [value.id, value]));
  const digestPaperIds = new Set(digest.paperIds ?? []);

  for (const review of acceptedReviews) {
    const paper = papersById.get(review.paperId);
    const versionlessArxivId = review.arxivVersion?.replace(/v\d+$/, "");
    const candidate = candidateByArxivId.get(versionlessArxivId);
    if (candidatesPath && !candidate) {
      errors.push(`Accepted review '${review.paperId}' cannot be joined to this run's candidates.`);
    }
    if (!paper) {
      errors.push(`Accepted review '${review.paperId}' has no canonical paper record.`);
      continue;
    }
    if (!digestPaperIds.has(review.paperId)) {
      errors.push(`Accepted review '${review.paperId}' is missing from digest '${digest.date}'.`);
    }
    if (candidate?.disposition === "new" && paper.collectedAt !== digest.date) {
      errors.push(`${review.paperId}.collectedAt must equal first digest date '${digest.date}'.`);
    } else if (
      candidate?.disposition !== "new" &&
      (typeof paper.collectedAt !== "string" || paper.collectedAt > digest.date)
    ) {
      errors.push(`${review.paperId}.collectedAt must preserve its original date on updates.`);
    }
    if (paper.analysis?.sourceScope !== "full_text") {
      errors.push(`${review.paperId}.analysis.sourceScope must remain 'full_text'.`);
    }
    if (paper.analysis?.readingAction !== review.readingAction) {
      errors.push(
        `${review.paperId}.analysis.readingAction '${paper.analysis?.readingAction}' does not match review '${review.readingAction}'.`,
      );
    }
    if (paper.analysis?.relevance !== review.relevance) {
      errors.push(
        `${review.paperId}.analysis.relevance '${paper.analysis?.relevance}' does not match review '${review.relevance}'.`,
      );
    }
    if (paper.primaryTopicId !== review.primaryTopicId) {
      errors.push(
        `${review.paperId}.primaryTopicId '${paper.primaryTopicId}' does not match review '${review.primaryTopicId}'.`,
      );
    }
    const versionLabel = `arXiv v${review.arxivVersion.match(/v(\d+)$/)?.[1] ?? ""}`;
    if (
      !paper.analysis?.sourceNote?.includes(review.arxivVersion) &&
      !paper.analysis?.sourceNote
        ?.toLocaleLowerCase("en-US")
        .includes(versionLabel.toLocaleLowerCase("en-US"))
    ) {
      errors.push(`${review.paperId}.analysis.sourceNote must name reviewed ${versionLabel}.`);
    }
    const expectedPaperUrl = `https://arxiv.org/abs/${review.arxivVersion}`;
    const paperLink = paper.links?.find((link) => link.label === "Paper");
    if (paperLink?.href !== expectedPaperUrl) {
      errors.push(`${review.paperId} Paper link must be '${expectedPaperUrl}'.`);
    }
    if (paper.abstractSourceUrl !== expectedPaperUrl || paper.abstractIsOriginal !== true) {
      errors.push(`${review.paperId} must retain the original abstract from '${expectedPaperUrl}'.`);
    }
    const codeLink = paper.links?.find((link) => link.label === "Code");
    if (review.code.status === "available") {
      if (codeLink?.href !== review.code.url) {
        errors.push(`${review.paperId} must retain reviewed Code URL '${review.code.url}'.`);
      }
    } else if (codeLink) {
      errors.push(`${review.paperId} must not publish a Code link with review status '${review.code.status}'.`);
    }
  }

  for (const paperId of digestPaperIds) {
    if (!reviewsByPaperId.has(paperId)) {
      errors.push(`Digest '${digest.date}' includes '${paperId}' without an accepted full-text review.`);
    }
  }

  if (digestPaperIds.size !== acceptedReviews.length) {
    errors.push(
      `Digest '${digest.date}' contains ${digestPaperIds.size} papers, but ${acceptedReviews.length} accepted reviews were expected.`,
    );
  }

  return {
    errors,
    acceptedCount: acceptedReviews.length,
    digestDate: digest.date ?? null,
    acceptedPaperIds: acceptedReviews.map((review) => review.paperId),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const result = validatePromotion(options);
  if (result.errors.length) {
    process.stderr.write(`Paper promotion validation failed (${result.errors.length} error(s)):\n`);
    result.errors.forEach((error) => process.stderr.write(`- ${error}\n`));
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `[paper-reading] valid promotion: ${result.acceptedCount} accepted full-text reviews -> ${result.digestDate} digest and canonical records\n`,
    );
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
