import { createHash } from "node:crypto";
import { buildIdentityKeys } from "./identity.mjs";

export function candidatePaperId(candidate) {
  return candidate.identifiers?.arxiv?.length === 1
    ? `arxiv:${candidate.identifiers.arxiv[0].replace(/v\d+$/, "")}`
    : candidate.existingMatch?.paperId ?? candidate.identity?.primaryKey ?? buildIdentityKeys(candidate)[0]?.key;
}
export function sourceVersionFor(candidate) {
  const evidence = { title: candidate.title, authors: candidate.authors, abstract: candidate.abstract ?? "",
    sources: (candidate.sourceRecords ?? []).map(({ source, sourceRecordId, url, publishedAt, updatedAt }) =>
      ({ source, sourceRecordId, url, publishedAt, updatedAt })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
  return `source-${createHash("sha256").update(JSON.stringify(evidence)).digest("hex").slice(0, 24)}`;
}
export const reviewVersion = (review) => review.arxivVersion ?? review.sourceVersion;
