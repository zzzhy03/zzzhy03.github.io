import { discoverConferences, fetchConference } from "./conference-common.mjs";
import { normalizeDoi } from "../lib/identity.mjs";

const value = (content, key) => content?.[key]?.value ?? content?.[key];
const timestamp = (number) => Number.isFinite(number) ? new Date(number).toISOString() : null;

export function normalizeOpenReviewNote(note, edition) {
  if (value(note.content, "venueid") !== edition.venue || note.replyto || (note.forum && note.id !== note.forum)) return null;
  const title = value(note.content, "title"), authors = value(note.content, "authors");
  if (!title || !Array.isArray(authors) || !authors.length) throw new Error("Accepted note has incomplete title/authors.");
  const forum = note.forum ?? note.id;
  const doi = normalizeDoi(value(note.content, "doi")), pdf = value(note.content, "pdf");
  return { title, authors, abstract: value(note.content, "abstract") ?? "",
    publishedAt: timestamp(note.pdate ?? note.cdate), updatedAt: timestamp(note.mdate ?? note.tmdate),
    sourceRecordId: forum, identifiers: { arxiv: [], doi: doi ? [doi] : [], openReviewForum: [forum] },
    links: [{ label: "Paper", href: `https://openreview.net/forum?id=${encodeURIComponent(forum)}` },
      ...(pdf ? [{ label: "PDF", href: new URL(pdf, "https://openreview.net").href }] : [])] };
}

export async function discoverOpenReview(context = {}) {
  return discoverConferences("openreview", ["openreview"], context, async (edition, ctx, status) => {
    const records = [], seen = new Set();
    const limit = 1000;
    for (let offset = 0; ; offset += limit) {
      const url = new URL("https://api2.openreview.net/notes");
      url.searchParams.set("content.venueid", edition.venue);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("sort", "id:asc");
      const data = await fetchConference(url, ctx, status);
      if (!Array.isArray(data.notes)) throw new Error("OpenReview response has no notes array.");
      for (const note of data.notes) {
        if (seen.has(note.id)) throw new Error("OpenReview pagination repeated a note; refusing incomplete coverage.");
        seen.add(note.id);
        const record = normalizeOpenReviewNote(note, edition);
        if (record) records.push(record);
      }
      if (data.notes.length < limit) {
        if (Number.isFinite(data.count) && offset + data.notes.length < data.count) throw new Error("OpenReview returned a truncated page.");
        break;
      }
    }
    return records;
  });
}
