import { locallyMatchesDirection } from "../lib/query-compiler.mjs";

export function decodeHtml(value = "") {
  return String(value).replace(/<[^>]*>/g, " ").replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi, (entity) => {
    const named = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " };
    if (named[entity]) return named[entity];
    const code = entity.startsWith("&#x") ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  }).replace(/\s+/g, " ").trim();
}

export function conferenceRecord(record, edition, context) {
  const directions = context.researchConfig.directions.filter((direction) => !context.topicIds || context.topicIds.includes(direction.id));
  const topics = directions.filter((direction) => locallyMatchesDirection(record, direction)).map((direction) => direction.id);
  // Missing abstracts cannot establish irrelevance: retain metadata for explicit screening.
  if (!topics.length && record.abstract) return null;
  const venue = context.venueRegistry.venues.find((item) => item.id === edition.venueId);
  const fallbackTopics = [...new Set([...(venue?.primaryTopicIds ?? []), ...(venue?.secondaryTopicIds ?? [])])]
    .filter((id) => directions.some((direction) => direction.id === id));
  if (!topics.length && !fallbackTopics.length) return null;
  return {
    ...record, year: edition.year, categories: [], venueText: `${venue?.name ?? edition.venueId} ${edition.year}`,
    retrievalTopicIds: topics.length ? topics : fallbackTopics, locallyMatchedTopicIds: topics,
    windowMatch: { inWindow: true, publishedInWindow: false, updatedInWindow: false, changeKind: "conference" },
    sourceNotes: { conference: { editionId: edition.id, venueId: edition.venueId, year: edition.year, dateBasis: record.publishedAt ? "provider-publication-date" : "unknown" } },
    sourceRecords: [{ source: edition.provider === "openreview" ? "openreview" : "venue-proceedings",
      provider: edition.provider, editionId: edition.id, sourceRecordId: record.sourceRecordId,
      url: record.links.find((link) => link.label === "Paper").href,
      publishedAt: record.publishedAt ?? null, updatedAt: record.updatedAt ?? null, retrievedAt: context.now }],
  };
}

export async function fetchConference(url, context, status, format = "json") {
  const wait = context.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  await wait(1100);
  status.requestCount += 1;
  const response = await (context.fetchImpl ?? globalThis.fetch)(url, {
    headers: { Accept: format === "json" ? "application/json" : "text/html", "User-Agent": "paper-reading-radar/0.2 (+https://zzzhy03.github.io/)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return format === "json" ? response.json() : response.text();
}

export async function discoverConferences(id, providers, context, retrieve) {
  const editions = (context.conferenceEditions ?? []).filter((edition) => providers.includes(edition.provider));
  const status = { id, implementation: providers.join("+"), mode: "conference-editions", status: "not-configured", live: editions.length > 0,
    requestCount: 0, fetchedEntryCount: 0, inWindowEntryCount: 0, queries: [] };
  const records = [];
  for (const edition of editions) {
    const query = { id: edition.id, status: "checked", fetchedEntryCount: 0, matchedEntryCount: 0 };
    status.queries.push(query);
    try {
      const items = await retrieve(edition, context, status);
      if (!items.length) throw new Error("No public proceedings/accepted papers returned; publication availability is unverified.");
      query.fetchedEntryCount = items.length;
      for (const item of items) {
        const record = conferenceRecord(item, edition, context);
        if (record) { records.push(record); query.matchedEntryCount += 1; }
      }
    } catch (error) {
      query.status = "failed";
      query.error = error.message;
    }
  }
  if (editions.length) {
    const failed = status.queries.filter((query) => query.status === "failed").length;
    status.status = failed === editions.length ? "failed" : failed ? "partial" : "checked";
  }
  status.fetchedEntryCount = status.queries.reduce((sum, query) => sum + query.fetchedEntryCount, 0);
  status.inWindowEntryCount = records.length;
  return { records, status };
}
