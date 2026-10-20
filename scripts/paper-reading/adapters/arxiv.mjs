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
export const ARXIV_MAX_REQUEST_ATTEMPTS = 3;
export const ARXIV_RETRY_BASE_DELAY_MS = 1_000;

const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryableHttpStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function networkErrorCode(error) {
  const visited = new Set();
  let current = error;
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    if (typeof current.code === "string") return current.code;
    current = current.cause;
  }
  return null;
}

function retryableNetworkError(error) {
  const code = networkErrorCode(error);
  return Boolean(
    (code && RETRYABLE_NETWORK_ERROR_CODES.has(code)) ||
      (error instanceof Error && error.name === "TimeoutError"),
  );
}

function describeNetworkError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = networkErrorCode(error);
  return `Network error${code ? ` ${code}` : ""}: ${message}`;
}

function httpError(response) {
  return `HTTP ${response.status} ${response.statusText}`.trim();
}

function retryDelayForAttempt(attempt) {
  return ARXIV_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
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
    successfulRequestCount: 0,
    retryCount: 0,
    requests: [],
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
  sleepImpl = sleep,
  clockImpl = Date.now,
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
  let lastRequestStartedAt = null;

  async function throttledFetch(url) {
    const elapsed = clockImpl() - lastRequestStartedAt;
    if (lastRequestStartedAt !== null && elapsed < effectiveDelayMs) {
      await sleepImpl(effectiveDelayMs - elapsed);
    }
    lastRequestStartedAt = clockImpl();
    return fetchImpl(url, {
      headers: {
        Accept: "application/atom+xml",
        "User-Agent": "paper-reading-radar/0.1 (+https://zzzhy03.github.io/)",
      },
    });
  }

  async function fetchPageWithRetry(url, queryStatus, start, requestSize) {
    const request = {
      start,
      maxResults: requestSize,
      status: "pending",
      attempts: [],
    };
    queryStatus.requests.push(request);

    async function handleNetworkFailure(error, attempt, stage) {
      const retryable = retryableNetworkError(error);
      const willRetry = retryable && attempt < ARXIV_MAX_REQUEST_ATTEMPTS;
      const errorMessage = describeNetworkError(error);
      const nextRetryDelayMs = willRetry ? retryDelayForAttempt(attempt) : null;
      request.attempts.push({
        attempt,
        outcome: "network-error",
        stage,
        error: errorMessage,
        retryable,
        nextRetryDelayMs,
      });
      if (!willRetry) {
        request.status = "failed";
        request.error = errorMessage;
        throw new Error(errorMessage, { cause: error });
      }
      queryStatus.retryCount += 1;
      await sleepImpl(nextRetryDelayMs);
    }

    for (let attempt = 1; attempt <= ARXIV_MAX_REQUEST_ATTEMPTS; attempt += 1) {
      queryStatus.requestCount += 1;
      let response;
      try {
        response = await throttledFetch(url);
      } catch (error) {
        await handleNetworkFailure(error, attempt, "fetch");
        continue;
      }

      if (!response.ok) {
        const retryable = retryableHttpStatus(response.status);
        const willRetry = retryable && attempt < ARXIV_MAX_REQUEST_ATTEMPTS;
        const errorMessage = httpError(response);
        const nextRetryDelayMs = willRetry ? retryDelayForAttempt(attempt) : null;
        request.attempts.push({
          attempt,
          outcome: "http-error",
          httpStatus: response.status,
          error: errorMessage,
          retryable,
          nextRetryDelayMs,
        });
        if (!willRetry) {
          request.status = "failed";
          request.error = errorMessage;
          throw new Error(errorMessage);
        }
        queryStatus.retryCount += 1;
        await sleepImpl(nextRetryDelayMs);
        continue;
      }

      let responseText;
      try {
        responseText = await response.text();
      } catch (error) {
        await handleNetworkFailure(error, attempt, "body");
        continue;
      }

      queryStatus.successfulRequestCount += 1;
      request.status = "succeeded";
      request.attempts.push({
        attempt,
        outcome: "success",
        httpStatus: response.status,
      });
      return responseText;
    }

    throw new Error("arXiv request retry loop ended unexpectedly.");
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

        const responseText = await fetchPageWithRetry(
          url,
          queryStatus,
          start,
          requestSize,
        );

        const feed = parseArxivAtomFeed(responseText);
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
      queryStatus.status =
        queryStatus.successfulRequestCount > 0 ? "partial" : "failed";
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
      successfulRequestCount: queryStatuses.reduce(
        (sum, query) => sum + query.successfulRequestCount,
        0,
      ),
      retryCount: queryStatuses.reduce((sum, query) => sum + query.retryCount, 0),
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
      retryPolicy: {
        maxAttemptsPerRequest: ARXIV_MAX_REQUEST_ATTEMPTS,
        retryableHttpStatuses: [429, "500-599"],
        retryableNetworkErrorCodes: [...RETRYABLE_NETWORK_ERROR_CODES].sort(),
        backoff: {
          strategy: "exponential",
          baseDelayMs: ARXIV_RETRY_BASE_DELAY_MS,
          maximumDelayMs: retryDelayForAttempt(ARXIV_MAX_REQUEST_ATTEMPTS - 1),
        },
      },
      pagination: {
        pageSize: effectivePageSize,
        maxResultsPerTopic: effectiveMaximum,
        truncationMakesRunPartial: true,
      },
    },
  };
}
