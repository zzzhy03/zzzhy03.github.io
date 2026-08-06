#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { validateFulltextReviews } from "./validate.mjs";

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
    if (argument === "--run-dir") options.runDirectory = next();
    else if (argument === "--reviews-dir") {
      options.reviewDirectory = next();
      options.reviewDirectoryExplicit = true;
    }
    else if (argument === "--research-config") options.researchConfig = next();
    else if (argument === "--screening-run-dir") options.screeningRunDirectory = next();
    else if (argument === "--selection") options.selection = next();
    else if (argument === "--expected-count") options.expectedCount = Number(next());
    else if (argument === "--output") {
      options.output = next();
      options.outputExplicit = true;
    }
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.runDirectory) {
    if (options.reviewDirectoryExplicit || options.screeningRunDirectory) {
      throw new Error("Use --run-dir by itself instead of combining it with review/screening paths.");
    }
    options.reviewDirectory = path.join(options.runDirectory, "fulltext", "reviews");
    options.screeningRunDirectory = options.runDirectory;
    if (!options.outputExplicit) {
      options.output = path.join(options.runDirectory, "fulltext", "summary.json");
    }
  }
  if (!options.reviewDirectory) throw new Error("--run-dir <directory> is required.");
  if (!options.output) throw new Error("--output <file> is required with --reviews-dir.");
  return options;
}

const options = parseArguments(process.argv.slice(2));
const result = validateFulltextReviews(options);
if (result.errors.length) {
  throw new Error(`Refusing to summarize invalid reviews:\n${result.errors.map((item) => `- ${item}`).join("\n")}`);
}

const rank = { "accept-deep": 0, "accept-skim": 1, defer: 2, reject: 3 };
const confidenceRank = { high: 0, medium: 1, low: 2 };
const reviewedPapers = [...result.reviews]
  .sort((left, right) => {
    return (
      rank[left.decision] - rank[right.decision] ||
      confidenceRank[left.confidence] - confidenceRank[right.confidence] ||
      left.title.localeCompare(right.title)
    );
  })
  .map((review) => ({
    paperId: review.paperId,
    arxivVersion: review.arxivVersion,
    title: review.title,
    decision: review.decision,
    primaryTopicId: review.primaryTopicId,
    secondaryTopicIds: review.secondaryTopicIds,
    relevance: review.relevance,
    readingAction: review.readingAction,
    confidence: review.confidence,
    thirtySecondZh: review.thirtySecondZh,
    code: review.code,
    reviewFile: path.join(options.reviewDirectory, `${review.arxivVersion}.json`),
  }));

const summary = {
  schemaVersion: 1,
  kind: "paper-reading-fulltext-review-summary",
  generatedAt: new Date().toISOString(),
  status: "validated-fulltext-summary",
  source: {
    reviewDirectory: options.reviewDirectory,
    screeningRunDirectory: options.screeningRunDirectory ?? null,
    selection: options.screeningRunDirectory ? options.selection : null,
  },
  counts: result.counts,
  firstDigestCandidates: reviewedPapers.filter((paper) => paper.decision.startsWith("accept-")),
  deferredOrRejected: reviewedPapers.filter((paper) => !paper.decision.startsWith("accept-")),
  scopeNoteZh:
    options.screeningRunDirectory && options.selection === "high-deep"
      ? "本汇总只覆盖 abstract screening 中 preliminary relevance=high 且 readingAction=deep 的全文候选；其它较低优先级 full-text-review 候选不在本轮内。"
      : "本汇总覆盖本次校验选择中的全部全文候选。",
  noteZh:
    "该文件只汇总全文审阅决定，不推断 promotion 或发布状态；canonical、digest 与发布边界必须由独立 validator 判断。",
};

const outputPath = path.resolve(options.output);
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${outputPath}\n`);
