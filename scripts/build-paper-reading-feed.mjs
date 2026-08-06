/**
 * Build bounded, per-date JSON bundles for the static Paper Reading client.
 *
 * Input: canonical topics, papers, and digests under content/paper-reading.
 * Output: generated public/paper-reading/data files consumed only after date selection.
 * Example: npm run prepare:papers
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const contentRoot = path.join(root, "content", "paper-reading");
const outputRoot = path.join(root, "public", "paper-reading", "data");
const digestOutputRoot = path.join(outputRoot, "digests");
const paperOutputRoot = path.join(outputRoot, "papers");

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readJsonDirectory(directory) {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => readJson(path.join(directory, file)));
}

const topics = readJson(path.join(contentRoot, "topics.json"));
const researchConfig = readJson(path.join(contentRoot, "research-config.json"));
const venueRegistry = readJson(path.join(contentRoot, "venue-registry.json"));
const papers = readJsonDirectory(path.join(contentRoot, "papers"));
const digests = readJsonDirectory(path.join(contentRoot, "digests")).sort((left, right) =>
  right.date.localeCompare(left.date),
);
const papersById = new Map(papers.map((paper) => [paper.id, paper]));
const digestDatesByPaperId = new Map();

for (const digest of digests) {
  for (const paperId of digest.paperIds) {
    const dates = digestDatesByPaperId.get(paperId) || [];
    dates.push(digest.date);
    digestDatesByPaperId.set(paperId, dates);
  }
}

function inferIdentifiers(paper) {
  const identifiers = { ...(paper.identifiers || {}) };
  const arxivIdMatch = paper.id.match(/^arxiv:(.+?)(?:v\d+)?$/i);
  const doiIdMatch = paper.id.match(/^doi:(.+)$/i);
  const openReviewIdMatch = paper.id.match(/^openreview:(.+)$/i);

  if (!identifiers.arxiv && arxivIdMatch) {
    identifiers.arxiv = arxivIdMatch[1];
  }
  if (!identifiers.doi && doiIdMatch) {
    identifiers.doi = doiIdMatch[1];
  }
  if (!identifiers.openReviewForum && openReviewIdMatch) {
    identifiers.openReviewForum = openReviewIdMatch[1];
  }

  for (const link of paper.links) {
    if (!identifiers.arxiv) {
      const match = link.href.match(
        /arxiv\.org\/(?:abs|pdf)\/([^/?#]+?)(?:v\d+)?(?:\.pdf)?(?:[?#]|$)/i,
      );
      if (match) identifiers.arxiv = match[1];
    }
    try {
      const url = new URL(link.href);
      if (!identifiers.doi && /^(?:dx\.)?doi\.org$/i.test(url.hostname)) {
        identifiers.doi = decodeURIComponent(url.pathname.replace(/^\//, ""));
      }
      if (!identifiers.openReviewForum) {
        if (/^(?:www\.)?openreview\.net$/i.test(url.hostname) && url.searchParams.get("id")) {
          identifiers.openReviewForum = url.searchParams.get("id");
        }
      }
    } catch {
      // Source validation reports malformed links before this build runs.
    }
  }

  return identifiers;
}

function inferPublicationType(paper) {
  if (paper.publicationType) return paper.publicationType;
  if (paper.venueIds?.length) return "peer-reviewed";
  if (/technical\s+report|tech(?:nical)?\.?\s*report/i.test(paper.venue)) {
    return "technical-report";
  }
  return "preprint";
}

function buildLibraryEntry(paper) {
  const digestDates = [...new Set(digestDatesByPaperId.get(paper.id) || [])].sort();
  const paperHref = paper.links.find((link) => link.label === "Paper")?.href;
  const codeHref = paper.links.find((link) => link.label === "Code")?.href;
  const primaryTopicId = paper.primaryTopicId || paper.topicIds[0];

  if (!paperHref || !primaryTopicId) {
    throw new Error(`[paper-reading] Cannot build library entry for '${paper.id}'.`);
  }

  return {
    id: paper.id,
    slug: paper.slug,
    title: paper.title,
    authors: paper.authors,
    publishedAt: paper.publishedAt,
    ...(paper.updatedAt ? { updatedAt: paper.updatedAt } : {}),
    collectedAt: paper.collectedAt,
    venue: paper.venue,
    identifiers: inferIdentifiers(paper),
    venueIds: paper.venueIds || [],
    publicationType: inferPublicationType(paper),
    categories: paper.categories,
    topicIds: paper.topicIds,
    primaryTopicId,
    keywords: paper.keywords,
    facets: paper.facets || {},
    firstReportedDate: digestDates[0] || null,
    lastReportedDate: digestDates.at(-1) || null,
    digestDates,
    paperHref,
    ...(codeHref ? { codeHref } : {}),
    hasCode: Boolean(codeHref),
    ideaZh: paper.analysis.ideaZh,
    sourceScope: paper.analysis.sourceScope,
    relevance: paper.analysis.relevance,
    readingAction: paper.analysis.readingAction,
    evidenceMaturity: paper.analysis.evidenceMaturity,
  };
}

const libraryIndex = papers.map(buildLibraryEntry).sort((left, right) => {
  const collectedOrder = right.collectedAt.localeCompare(left.collectedAt);
  if (collectedOrder !== 0) return collectedOrder;
  const publishedOrder = right.publishedAt.localeCompare(left.publishedAt);
  if (publishedOrder !== 0) return publishedOrder;
  return left.title.localeCompare(right.title, "en");
});

const latestGeneratedAt = digests
  .map((digest) => digest.generatedAt)
  .sort((left, right) => Date.parse(right) - Date.parse(left))[0];

if (!latestGeneratedAt) {
  throw new Error("[paper-reading] At least one digest is required to build the feed.");
}

const libraryMeta = {
  schemaVersion: 1,
  generatedAt: latestGeneratedAt,
  topics: topics.map(({ id, labelZh, labelEn, shortLabel, accent }) => ({
    id,
    labelZh,
    labelEn,
    shortLabel,
    accent,
  })),
  venues: venueRegistry.venues.map(({ id, name }) => ({ id, label: name })),
  facetDimensions: researchConfig.tagTaxonomy.dimensions.map(({ id, labelZh, values }) => ({
    id,
    labelZh,
    values: values.map(({ id: valueId, label }) => ({ id: valueId, label })),
  })),
  publicationTypes: [
    { id: "peer-reviewed", label: "Peer-reviewed", labelZh: "正式发表" },
    { id: "preprint", label: "Preprint", labelZh: "预印本" },
    { id: "technical-report", label: "Technical Report", labelZh: "技术报告" },
  ],
  relevanceOptions: [
    { id: "high", label: "High", labelZh: "高相关" },
    { id: "medium", label: "Medium", labelZh: "中相关" },
    { id: "low", label: "Low", labelZh: "低相关" },
  ],
  readingActionOptions: [
    { id: "deep", label: "Deep read", labelZh: "精读" },
    { id: "skim", label: "Skim", labelZh: "略读" },
    { id: "skip", label: "Skip", labelZh: "暂不读" },
  ],
  sourceScopeOptions: [
    { id: "full_text", label: "Full text", labelZh: "全文" },
    { id: "abstract", label: "Abstract", labelZh: "Abstract" },
    { id: "metadata", label: "Metadata", labelZh: "Metadata" },
  ],
  evidenceMaturityOptions: [
    { id: "solid", label: "Solid", labelZh: "证据较充分" },
    { id: "mixed", label: "Mixed", labelZh: "证据有限" },
    { id: "early", label: "Early", labelZh: "早期结果" },
  ],
};

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(digestOutputRoot, { recursive: true });
mkdirSync(paperOutputRoot, { recursive: true });

for (const digest of digests) {
  const bundle = {
    digest,
    papers: digest.paperIds.map((paperId) => papersById.get(paperId)),
  };
  writeFileSync(
    path.join(digestOutputRoot, `${digest.date}.json`),
    `${JSON.stringify(bundle)}\n`,
  );
}

for (const paper of papers) {
  writeFileSync(
    path.join(paperOutputRoot, `${paper.slug}.json`),
    `${JSON.stringify(paper)}\n`,
  );
}

writeFileSync(
  path.join(outputRoot, "paper-index.json"),
  `${JSON.stringify(libraryIndex)}\n`,
);

writeFileSync(
  path.join(outputRoot, "library-meta.json"),
  `${JSON.stringify(libraryMeta)}\n`,
);

writeFileSync(
  path.join(outputRoot, "index.json"),
  `${JSON.stringify(
    digests.map(({ date, generatedAt, mode }) => ({ date, generatedAt, mode })),
  )}\n`,
);

console.log(
  `[paper-reading] prepared ${digests.length} per-date bundles, ${papers.length} library records, and safe filter metadata`,
);
