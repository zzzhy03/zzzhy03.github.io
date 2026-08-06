import { createHash } from "node:crypto";

import {
  buildIdentityKeys,
  extractIdentifiers,
  normalizeTitle,
  parseArxivIdentifier,
} from "./identity.mjs";
import { buildVenueAliasIndex, matchVenueIds } from "./venue.mjs";

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined))];
}

function richerText(left, right) {
  if (!left) return right ?? left;
  if (!right) return left;
  return right.length > left.length ? right : left;
}

function mergeLinks(records) {
  const links = new Map();
  for (const record of records) {
    for (const link of record.links ?? []) {
      if (link?.href) links.set(`${link.label ?? "Link"}|${link.href}`, link);
    }
  }
  return [...links.values()];
}

function mergeSourceRecords(records) {
  const sources = new Map();
  for (const record of records) {
    for (const source of record.sourceRecords ?? []) {
      const key = `${source.source}|${source.sourceRecordId ?? source.url}`;
      sources.set(key, source);
    }
  }
  return [...sources.values()].sort((left, right) =>
    `${left.source}:${left.sourceRecordId}`.localeCompare(
      `${right.source}:${right.sourceRecordId}`,
    ),
  );
}

function mergeWindowMatch(records) {
  const publishedInWindow = records.some((record) => record.windowMatch?.publishedInWindow);
  const updatedInWindow = records.some((record) => record.windowMatch?.updatedInWindow);
  return {
    inWindow: publishedInWindow || updatedInWindow,
    publishedInWindow,
    updatedInWindow,
    changeKind: publishedInWindow ? "new" : updatedInWindow ? "updated" : null,
  };
}

function mergeRecordGroup(records, venueAliasIndex) {
  const preferred = [...records].sort((left, right) => {
    const leftScore = (left.abstract?.length ?? 0) + (left.authors?.length ?? 0) * 10;
    const rightScore = (right.abstract?.length ?? 0) + (right.authors?.length ?? 0) * 10;
    return rightScore - leftScore;
  })[0];
  const identifiers = records.reduce(
    (merged, record) => {
      const extracted = extractIdentifiers(record);
      merged.doi.push(...extracted.doi);
      merged.arxiv.push(...extracted.arxiv);
      merged.openreview.push(...extracted.openreview);
      return merged;
    },
    { doi: [], arxiv: [], openreview: [] },
  );
  identifiers.doi = unique(identifiers.doi).sort();
  identifiers.arxiv = unique(identifiers.arxiv).sort();
  identifiers.openReviewForum = unique(identifiers.openreview).sort();
  delete identifiers.openreview;

  const merged = {
    title: preferred.title,
    authors: preferred.authors,
    year: preferred.year,
    publishedAt: records
      .map((record) => record.publishedAt)
      .filter(Boolean)
      .sort()[0],
    updatedAt: records
      .map((record) => record.updatedAt)
      .filter(Boolean)
      .sort()
      .at(-1),
    abstract: records.reduce(
      (current, record) => richerText(current, record.abstract),
      "",
    ),
    categories: unique(records.flatMap((record) => record.categories ?? [])).sort(),
    primaryCategory: preferred.primaryCategory ?? null,
    identifiers,
    arxivVersion: Math.max(
      ...records.map((record) => record.arxivVersion ?? 0),
      0,
    ),
    venueText: records.reduce(
      (current, record) => richerText(current, record.venueText),
      "",
    ),
    sourceNotes: {
      journalRef: records.reduce(
        (current, record) => richerText(current, record.sourceNotes?.journalRef),
        null,
      ),
      comments: records.reduce(
        (current, record) => richerText(current, record.sourceNotes?.comments),
        null,
      ),
    },
    links: mergeLinks(records),
    retrievalTopicIds: unique(
      records.flatMap((record) => record.retrievalTopicIds ?? []),
    ).sort(),
    locallyMatchedTopicIds: unique(
      records.flatMap((record) => record.locallyMatchedTopicIds ?? []),
    ).sort(),
    windowMatch: mergeWindowMatch(records),
    sourceRecords: mergeSourceRecords(records),
  };
  const identityKeys = buildIdentityKeys(merged);
  const primaryIdentity = identityKeys[0];
  merged.identity = {
    primaryKey: primaryIdentity?.key ?? null,
    keys: identityKeys,
  };
  merged.discoveryId = `candidate:${createHash("sha256")
    .update(primaryIdentity?.key ?? `${normalizeTitle(merged.title)}|${merged.publishedAt}`)
    .digest("hex")
    .slice(0, 20)}`;
  merged.venueMatches = matchVenueIds(merged, venueAliasIndex);

  const normalizedTitles = unique(records.map((record) => normalizeTitle(record.title)));
  merged.normalizationWarnings = [];
  if (normalizedTitles.length > 1) {
    merged.normalizationWarnings.push("Merged source records have different normalized titles.");
  }
  return merged;
}

class DisjointSet {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index) {
    if (this.parent[index] !== index) this.parent[index] = this.find(this.parent[index]);
    return this.parent[index];
  }

  union(left, right) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent[rightRoot] = leftRoot;
  }
}

export function mergeSourceDuplicates(records, venueRegistry) {
  const sets = new DisjointSet(records.length);
  const seenKeys = new Map();

  records.forEach((record, index) => {
    for (const identity of buildIdentityKeys(record)) {
      const previous = seenKeys.get(identity.key);
      if (previous !== undefined) sets.union(index, previous);
      else seenKeys.set(identity.key, index);
    }
  });

  const groups = new Map();
  records.forEach((record, index) => {
    const root = sets.find(index);
    const group = groups.get(root) ?? [];
    group.push(record);
    groups.set(root, group);
  });

  const venueAliasIndex = buildVenueAliasIndex(venueRegistry);
  return [...groups.values()]
    .map((group) => mergeRecordGroup(group, venueAliasIndex))
    .sort((left, right) => {
      const dateComparison = right.updatedAt.localeCompare(left.updatedAt);
      return dateComparison || left.title.localeCompare(right.title);
    });
}

export function buildCanonicalIndex(records) {
  const byIdentity = new Map();
  const byId = new Map();

  for (const record of records) {
    byId.set(record.id, record);
    for (const identity of buildIdentityKeys(record)) {
      const matches = byIdentity.get(identity.key) ?? [];
      matches.push({ paperId: record.id, identityType: identity.type });
      byIdentity.set(identity.key, matches);
    }
  }

  return { byIdentity, byId };
}

function maxArxivVersion(record) {
  const versions = [];
  for (const source of record.sourceRecords ?? []) {
    const parsed = parseArxivIdentifier(source.sourceRecordId ?? source.url);
    if (parsed?.version) versions.push(parsed.version);
  }
  for (const link of record.links ?? []) {
    const parsed = parseArxivIdentifier(link.href);
    if (parsed?.version) versions.push(parsed.version);
  }
  return versions.length ? Math.max(...versions) : null;
}

function detectedMetadataChanges(candidate, existing) {
  const changes = [];
  const existingIdentifiers = extractIdentifiers(existing);
  const newDois = candidate.identifiers.doi.filter(
    (doi) => !existingIdentifiers.doi.includes(doi),
  );
  if (newDois.length) changes.push({ field: "doi", values: newDois });

  const existingVersion = maxArxivVersion(existing);
  if (
    candidate.arxivVersion &&
    existingVersion &&
    candidate.arxivVersion > existingVersion
  ) {
    changes.push({
      field: "paper-version",
      previous: existingVersion,
      value: candidate.arxivVersion,
    });
  }

  if (
    candidate.sourceNotes?.journalRef &&
    normalizeTitle(candidate.sourceNotes.journalRef) !== normalizeTitle(existing.venue)
  ) {
    changes.push({
      field: "venue",
      previous: existing.venue ?? null,
      value: candidate.sourceNotes.journalRef,
    });
  }
  return changes;
}

export function matchCanonicalCandidates(candidates, canonicalIndex) {
  return candidates.map((candidate) => {
    const matches = [];
    for (const identity of candidate.identity.keys) {
      for (const canonicalMatch of canonicalIndex.byIdentity.get(identity.key) ?? []) {
        matches.push({
          paperId: canonicalMatch.paperId,
          matchType: identity.type,
          matchKey: identity.key,
        });
      }
    }

    const paperIds = unique(matches.map((match) => match.paperId));
    if (!paperIds.length) {
      return { ...candidate, disposition: "new", existingMatch: null };
    }
    if (paperIds.length > 1) {
      return {
        ...candidate,
        disposition: "manual-review",
        existingMatch: {
          ambiguous: true,
          paperIds: paperIds.sort(),
          matches,
        },
        normalizationWarnings: [
          ...candidate.normalizationWarnings,
          "Identity keys point to more than one canonical paper.",
        ],
      };
    }

    const paperId = paperIds[0];
    const existing = canonicalIndex.byId.get(paperId);
    const strongestMatch = matches.find((match) => match.paperId === paperId);
    const changes = detectedMetadataChanges(candidate, existing);
    return {
      ...candidate,
      disposition: changes.length ? "possible-update" : "duplicate-existing",
      existingMatch: {
        ambiguous: false,
        paperId,
        matchType: strongestMatch.matchType,
        matchKey: strongestMatch.matchKey,
        detectedChanges: changes,
      },
    };
  });
}
