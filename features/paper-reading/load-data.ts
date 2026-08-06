import "server-only";

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  DailyDigest,
  PaperReadingDataset,
  PaperRecord,
  PaperTopic,
} from "@/features/paper-reading/types";

const contentRoot = path.join(process.cwd(), "content", "paper-reading");

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function readJsonDirectory<T>(directory: string): T[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => readJson<T>(path.join(directory, file)));
}

function validateDataset(dataset: {
  topics: PaperTopic[];
  papers: PaperRecord[];
  digests: DailyDigest[];
}) {
  const topicIds = new Set(dataset.topics.map((topic) => topic.id));
  const paperIds = new Set(dataset.papers.map((paper) => paper.id));

  if (topicIds.size !== dataset.topics.length) {
    throw new Error("Paper Reading topic IDs must be unique.");
  }
  if (paperIds.size !== dataset.papers.length) {
    throw new Error("Paper Reading paper IDs must be unique.");
  }

  for (const paper of dataset.papers) {
    for (const topicId of paper.topicIds) {
      if (!topicIds.has(topicId)) {
        throw new Error(`Unknown topic '${topicId}' in paper '${paper.id}'.`);
      }
    }
  }

  for (const digest of dataset.digests) {
    for (const paperId of digest.paperIds) {
      if (!paperIds.has(paperId)) {
        throw new Error(`Unknown paper '${paperId}' in digest '${digest.date}'.`);
      }
    }
    for (const brief of digest.topicBriefs) {
      if (!topicIds.has(brief.topicId)) {
        throw new Error(`Unknown topic '${brief.topicId}' in digest '${digest.date}'.`);
      }
    }
  }
}

export function loadPaperReadingData(): PaperReadingDataset {
  const topics = readJson<PaperTopic[]>(path.join(contentRoot, "topics.json"));
  const papers = readJsonDirectory<PaperRecord>(path.join(contentRoot, "papers"));
  const digests = readJsonDirectory<DailyDigest>(path.join(contentRoot, "digests")).sort(
    (left, right) => right.date.localeCompare(left.date),
  );

  validateDataset({ topics, papers, digests });

  const latestDigest = digests[0];
  if (!latestDigest) {
    throw new Error("Paper Reading needs at least one digest.");
  }
  const papersById = new Map(papers.map((paper) => [paper.id, paper]));
  const latestPapers = latestDigest.paperIds.map((paperId) => {
    const paper = papersById.get(paperId);
    if (!paper) throw new Error(`Unknown paper '${paperId}' in latest digest.`);
    return paper;
  });

  return {
    topics,
    digestIndex: digests.map(({ date, generatedAt, mode }) => ({ date, generatedAt, mode })),
    initial: { digest: latestDigest, papers: latestPapers },
  };
}
