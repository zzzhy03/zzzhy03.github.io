import { readFile } from "node:fs/promises";

import { parseArxivAtomFeed } from "../lib/atom.mjs";
import {
  normalizeArxivId,
  normalizeDoi,
  parseArxivIdentifier,
} from "../lib/identity.mjs";
import {
  compileArxivQueries,
  locallyMatchesDirection,
} from "../lib/query-compiler.mjs";
import { classifyWindowMatch } from "../lib/window.mjs";

export const ARXIV_MIN_REQUEST_DELAY_MS = 3_100;
export const ARXIV_API_ENDPOINT = "https://export.arxiv.org/api/query";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function arxivSourceId(entry) {
  return parseArxivIdentifier(entry.id)?.id
    ? entry.id.replace(/^https?:\/\/(?:www\.)?arxiv\.org\/abs\//i, "")
    : entry.id;
}

function normalizeEntry(
  entry,
  topicIds,
  window,
  retrievedAt,
  locallyMatchedTopicIds = topicIds,
) {
  const parsedArxiv = parseArxivIdentifier(entry.id);
  const arxivId = normalizeArxivId(entry.id);
  if (!arxivId || !entry.title || !entry.publishedAt || !entry.updatedAt) {
    return null;
  }

  const windowMatch = classifyWindowMatch(entry, window);
  if (!windowMatch.inWindow) return null;

  const alternate = entry.links.find((link) => link.rel === "alternate")?.href;
  const paperUrl = alternate ?? `https://arxiv.org/abs/${arxivId}`;
  const doi = normalizeDoi(entry.doi);
  const links = [{ label: "Paper", href: paperUrl }];
  if (doi) links.push({ label: "DOI", href: `https://doi.org/${doi}` });

  return {
    title: entry.title,
    authors: entry.authors,
    year: new Date(entry.publishedAt).getUTCFullYear(),
    publishedAt: entry.publishedAt,
    updatedAt: entry.updatedAt,
    abstract: entry.abstract ?? "",
    categories: entry.categories,
    primaryCategory: entry.primaryCategory,
    identifiers: {
      doi: doi ? [doi] : [],
      arxiv: [arxivId],
      openReviewForum: [],
    },
    arxivVersion: parsedArxiv?.version ?? null,
    venueText: entry.journalRef ?? "arXiv preprint",
    sourceNotes: {
      journalRef: entry.journalRef,
      comments: entry.comments,
    },
    links,
    retrievalTopicIds: [...new Set(topicIds)].sort(),
    locallyMatchedTopicIds: [...new Set(locallyMatchedTopicIds)].sort(),
    windowMatch,
    sourceRecords: [
      {
        source: "arxiv",
        sourceRecordId: arxivSourceId(entry),
        url: paperUrl,
        publishedAt: entry.publishedAt,
        updatedAt: entry.updatedAt,
        retrievedAt,
      },
    ],
  };
}

function queryStatusBase(query) {
  return {
    id: query.id,
    topicId: query.topicId,
    familyCount: query.familyCount,
    query: query.query,
    sortBy: "lastUpdatedDate",
    sortOrder: "descending",
    requestCount: 0,
    fetchedEntryCount: 0,
    inWindowEntryCount: 0,
    locallyMatchedInWindowEntryCount: 0,
    providerOnlyInWindowEntryCount: 0,
    truncated: false,
    status: "checked",
  };
}

async function discoverFixture({ fixtureFile, queries, researchConfig, window, now }) {
  const xml = await readFile(fixtureFile, "utf8");
  const feed = parseArxivAtomFeed(xml);
  const directionById = new Map(
    researchConfig.directions.map((direction) => [direction.id, direction]),
  );
  const queryStatuses = queries.map((query) => ({
    ...queryStatusBase(query),
    mode: "fixture-local-evaluation",
  }));
  const matchesByEntry = new Map();

  for (const entry of feed.entries) {
    const topicIds = [];
    for (const [index, query] of queries.entries()) {
      const direction = directionById.get(query.topicId);
      if (direction && locallyMatchesDirection(entry, direction)) {
        topicIds.push(query.topicId);
        queryStatuses[index].fetchedEntryCount += 1;
      }
    }
    if (topicIds.length) matchesByEntry.set(entry, topicIds);
  }

  const records = [];
  for (const [entry, topicIds] of matchesByEntry) {
    const record = normalizeEntry(entry, topicIds, window, now);
    if (!record) continue;
    records.push(record);
    for (const topicId of topicIds) {
      const status = queryStatuses.find((query) => query.topicId === topicId);
      status.inWindowEntryCount += 1;
      status.locallyMatchedInWindowEntryCount += 1;
    }
  }

  return {
    records,
    status: {
      id: "arxiv",
      implementation: "atom-api",
      mode: "fixture",
      status: "checked",
      live: false,
      endpoint: ARXIV_API_ENDPOINT,
      requestCount: 0,
      fetchedEntryCount: feed.entries.length,
      inWindowEntryCount: records.length,
      queries: queryStatuses,
      rateLimit: {
        policy: "single serial connection; at least 3100 ms between live requests",
        minimumDelayMs: ARXIV_MIN_REQUEST_DELAY_MS,
        effectiveDelayMs: ARXIV_MIN_REQUEST_DELAY_MS,
        appliedToFixture: false,
      },
    },
  };
}

export async function discoverArxiv({
  researchConfig,
  topicIds,
  window,
  now,
  fixtureFile = null,
  fetchImpl = globalThis.fetch,
  requestDelayMs = ARXIV_MIN_REQUEST_DELAY_MS,
  pageSize = 100,
  maxResultsPerTopic = 300,
}) {
  const queries = compileArxivQueries(researchConfig, topicIds);
  if (!queries.length) {
    throw new Error("No configured research directions were selected for arXiv.");
  }
  if (fixtureFile) {
    return discoverFixture({ fixtureFile, queries, researchConfig, window, now });
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required for live arXiv discovery.");
  }

  const effectiveDelayMs = Math.max(ARXIV_MIN_REQUEST_DELAY_MS, requestDelayMs);
  const effectiveMaximum = Math.max(1, Math.floor(maxResultsPerTopic));
  const effectivePageSize = Math.min(
    effectiveMaximum,
    Math.max(1, Math.min(200, Math.floor(pageSize))),
  );
  const records = [];
  const queryStatuses = [];
  const directionById = new Map(
    researchConfig.directions.map((direction) => [direction.id, direction]),
  );
  let lastRequestStartedAt = 0;

  async function throttledFetch(url) {
    const elapsed = Date.now() - lastRequestStartedAt;
    if (lastRequestStartedAt && elapsed < effectiveDelayMs) {
      await sleep(effectiveDelayMs - elapsed);
    }
    lastRequestStartedAt = Date.now();
    return fetchImpl(url, {
      headers: {
        Accept: "application/atom+xml",
        "User-Agent": "paper-reading-radar/0.1 (+https://zzzhy03.github.io/)",
      },
    });
  }

  for (const query of queries) {
    const queryStatus = queryStatusBase(query);
    queryStatuses.push(queryStatus);
    let start = 0;

    try {
      while (start < effectiveMaximum) {
        const remaining = effectiveMaximum - start;
        const requestSize = Math.min(effectivePageSize, remaining);
        const url = new URL(ARXIV_API_ENDPOINT);
        url.searchParams.set("search_query", query.query);
        url.searchParams.set("start", String(start));
        url.searchParams.set("max_results", String(requestSize));
        url.searchParams.set("sortBy", "lastUpdatedDate");
        url.searchParams.set("sortOrder", "descending");

        const response = await throttledFetch(url);
        queryStatus.requestCount += 1;
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
        }

        const feed = parseArxivAtomFeed(await response.text());
        queryStatus.totalResultsReported = feed.totalResults;
        queryStatus.fetchedEntryCount += feed.entries.length;
        for (const entry of feed.entries) {
          const direction = directionById.get(query.topicId);
          const locallyMatched = Boolean(
            direction && locallyMatchesDirection(entry, direction),
          );
          const record = normalizeEntry(
            entry,
            [query.topicId],
            window,
            now,
            locallyMatched ? [query.topicId] : [],
          );
          if (record) {
            records.push(record);
            queryStatus.inWindowEntryCount += 1;
            if (locallyMatched) queryStatus.locallyMatchedInWindowEntryCount += 1;
            else queryStatus.providerOnlyInWindowEntryCount += 1;
          }
        }

        if (!feed.entries.length) break;
        start += feed.entries.length;

        const oldestUpdated = feed.entries
          .map((entry) => Date.parse(entry.updatedAt))
          .filter(Number.isFinite)
          .reduce((oldest, value) => Math.min(oldest, value), Number.POSITIVE_INFINITY);
        queryStatus.oldestUpdatedAtFetched = Number.isFinite(oldestUpdated)
          ? new Date(oldestUpdated).toISOString()
          : null;
        const crossedWindowStart =
          Number.isFinite(oldestUpdated) && oldestUpdated < Date.parse(window.start);
        const reachedReportedTotal =
          Number.isInteger(feed.totalResults) && start >= feed.totalResults;
        const incompleteShortPage =
          feed.entries.length < requestSize &&
          Number.isInteger(feed.totalResults) &&
          start < feed.totalResults &&
          !crossedWindowStart;
        if (incompleteShortPage) {
          queryStatus.truncated = true;
          queryStatus.status = "partial";
          queryStatus.error =
            "Provider returned a short page before the reported total and before the window boundary.";
          break;
        }
        if (crossedWindowStart || reachedReportedTotal || feed.entries.length < requestSize) {
          break;
        }

        if (start >= effectiveMaximum) {
          queryStatus.truncated = true;
          queryStatus.status = "partial";
        }
      }
    } catch (error) {
      queryStatus.status = queryStatus.requestCount > 0 ? "partial" : "failed";
      queryStatus.error = error instanceof Error ? error.message : String(error);
    }
  }

  const failedQueries = queryStatuses.filter((query) => query.status === "failed").length;
  const partialQueries = queryStatuses.filter((query) => query.status === "partial").length;
  const status =
    failedQueries === queryStatuses.length
      ? "failed"
      : failedQueries || partialQueries
        ? "partial"
        : "checked";

  return {
    records,
    status: {
      id: "arxiv",
      implementation: "atom-api",
      mode: "live",
      status,
      live: true,
      endpoint: ARXIV_API_ENDPOINT,
      requestCount: queryStatuses.reduce((sum, query) => sum + query.requestCount, 0),
      fetchedEntryCount: queryStatuses.reduce(
        (sum, query) => sum + query.fetchedEntryCount,
        0,
      ),
      inWindowEntryCount: queryStatuses.reduce(
        (sum, query) => sum + query.inWindowEntryCount,
        0,
      ),
      locallyMatchedInWindowEntryCount: queryStatuses.reduce(
        (sum, query) => sum + query.locallyMatchedInWindowEntryCount,
        0,
      ),
      providerOnlyInWindowEntryCount: queryStatuses.reduce(
        (sum, query) => sum + query.providerOnlyInWindowEntryCount,
        0,
      ),
      queries: queryStatuses,
      rateLimit: {
        policy: "single serial connection; at least 3100 ms between requests across all topics",
        minimumDelayMs: ARXIV_MIN_REQUEST_DELAY_MS,
        requestedDelayMs: requestDelayMs,
        effectiveDelayMs,
      },
      pagination: {
        pageSize: effectivePageSize,
        maxResultsPerTopic: effectiveMaximum,
        truncationMakesRunPartial: true,
      },
    },
  };
}
