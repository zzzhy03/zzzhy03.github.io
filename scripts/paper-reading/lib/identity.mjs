function decodeLooseUrlComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function valuesFrom(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

export function normalizeDoi(value) {
  if (typeof value !== "string") return null;

  const decoded = decodeLooseUrlComponent(value.trim());
  const withoutPrefix = decoded
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "");
  const match = withoutPrefix.match(/10\.\d{4,9}\/[-._;()/:a-z0-9]+/i);
  if (!match) return null;

  return match[0].replace(/[.,;:]+$/g, "").toLocaleLowerCase("en-US");
}

export function parseArxivIdentifier(value) {
  if (typeof value !== "string") return null;

  const decoded = decodeLooseUrlComponent(value.trim())
    .replace(/^arxiv:\s*/i, "")
    .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\//i, "")
    .replace(/\.pdf(?:[?#].*)?$/i, "")
    .replace(/[?#].*$/i, "");
  const match = decoded.match(
    /^((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7}))(?:v(\d+))?$/i,
  );
  if (!match) return null;

  return {
    id: match[1].toLocaleLowerCase("en-US"),
    version: match[2] ? Number(match[2]) : null,
  };
}

export function normalizeArxivId(value) {
  return parseArxivIdentifier(value)?.id ?? null;
}

export function normalizeOpenReviewForumId(value) {
  if (typeof value !== "string" || !value.trim()) return null;

  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if (url.hostname.toLocaleLowerCase("en-US").endsWith("openreview.net")) {
      const id = url.searchParams.get("id");
      return id?.trim() || null;
    }
  } catch {
    // A raw forum ID is valid input too.
  }

  return /^[A-Za-z0-9_-]{6,}$/.test(trimmed) ? trimmed : null;
}

export function normalizeTitle(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeAuthor(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function recordAuthors(record) {
  if (!Array.isArray(record.authors)) return [];
  return record.authors
    .map((author) => {
      if (typeof author === "string") return author;
      if (author && typeof author === "object") {
        return author.name ?? [author.given, author.family].filter(Boolean).join(" ");
      }
      return "";
    })
    .filter(Boolean);
}

function recordYear(record) {
  if (Number.isInteger(record.year)) return record.year;
  const candidates = [record.publishedAt, record.updatedAt];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return new Date(parsed).getUTCFullYear();
  }
  return null;
}

export function extractIdentifiers(record) {
  const doiValues = [];
  const arxivValues = [];
  const openReviewValues = [];

  for (const value of valuesFrom(record.identifiers?.doi ?? record.doi)) {
    doiValues.push(normalizeDoi(value));
  }
  for (const value of valuesFrom(record.identifiers?.arxiv ?? record.arxivId)) {
    arxivValues.push(normalizeArxivId(value));
  }
  for (const value of valuesFrom(
    record.identifiers?.openReviewForum ??
      record.identifiers?.openreview ??
      record.openReviewForumId,
  )) {
    openReviewValues.push(normalizeOpenReviewForumId(value));
  }

  if (typeof record.id === "string") {
    if (/^arxiv:/i.test(record.id)) arxivValues.push(normalizeArxivId(record.id));
    if (/^doi:/i.test(record.id)) doiValues.push(normalizeDoi(record.id));
    if (/^openreview:/i.test(record.id)) {
      openReviewValues.push(
        normalizeOpenReviewForumId(record.id.replace(/^openreview:/i, "")),
      );
    }
  }

  for (const link of Array.isArray(record.links) ? record.links : []) {
    if (!link || typeof link.href !== "string") continue;
    doiValues.push(normalizeDoi(link.href));
    arxivValues.push(normalizeArxivId(link.href));
    openReviewValues.push(normalizeOpenReviewForumId(link.href));
  }

  for (const sourceRecord of Array.isArray(record.sourceRecords)
    ? record.sourceRecords
    : []) {
    if (sourceRecord.source === "arxiv") {
      arxivValues.push(normalizeArxivId(sourceRecord.sourceRecordId));
      arxivValues.push(normalizeArxivId(sourceRecord.url));
    }
    if (sourceRecord.source === "openreview") {
      openReviewValues.push(normalizeOpenReviewForumId(sourceRecord.sourceRecordId));
      openReviewValues.push(normalizeOpenReviewForumId(sourceRecord.url));
    }
  }

  return {
    doi: unique(doiValues),
    arxiv: unique(arxivValues),
    openreview: unique(openReviewValues),
  };
}

export function buildIdentityKeys(record) {
  const identifiers = extractIdentifiers(record);
  const keys = [];

  for (const doi of identifiers.doi) {
    keys.push({ type: "doi", value: doi, key: `doi:${doi}` });
  }
  for (const arxiv of identifiers.arxiv) {
    keys.push({ type: "arxiv", value: arxiv, key: `arxiv:${arxiv}` });
  }
  for (const forumId of identifiers.openreview) {
    keys.push({
      type: "openreview",
      value: forumId,
      key: `openreview:${forumId}`,
    });
  }

  const title = normalizeTitle(record.title);
  const firstAuthor = normalizeAuthor(recordAuthors(record)[0]);
  const year = recordYear(record);
  if (title && firstAuthor && year) {
    const value = `${title}|${firstAuthor}|${year}`;
    keys.push({ type: "title-author-year", value, key: `tay:${value}` });
  }

  return keys;
}
