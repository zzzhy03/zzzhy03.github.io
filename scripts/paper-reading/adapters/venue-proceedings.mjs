import { decodeHtml, discoverConferences, fetchConference } from "./conference-common.mjs";
import { normalizeDoi } from "../lib/identity.mjs";

export function parseCvfIndex(html, edition) {
  const blocks = [...html.matchAll(/<dt\b[^>]*class=["']ptitle["'][^>]*>([\s\S]*?)(?=<dt\b|<\/dl>)/gi)];
  const records = [], seen = new Set();
  for (const [, block] of blocks) {
    const title = block.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!title) throw new Error("CVF paper is missing its title link.");
    const url = new URL(title[1], edition.indexUrl);
    if (url.origin !== "https://openaccess.thecvf.com" || !url.pathname.startsWith(`/content/${edition.venueId.toUpperCase()}${edition.year}/html/`)) {
      throw new Error("CVF index contains a different edition or unexpected paper URL.");
    }
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const authors = [...block.matchAll(/name=["']query_author["']\s+value=["']([^"']+)["']/g)].map((match) => decodeHtml(match[1]));
    if (!authors.length) throw new Error("CVF paper has no authors; index format may have changed.");
    const pdf = block.match(/href=["']([^"']+_paper\.pdf)["']/i);
    records.push({ title: decodeHtml(title[2]), authors, abstract: "", publishedAt: null, updatedAt: null,
      sourceRecordId: url.href, identifiers: { doi: [], arxiv: [], openReviewForum: [] },
      links: [{ label: "Paper", href: url.href }, ...(pdf ? [{ label: "PDF", href: new URL(pdf[1], url).href }] : [])] });
  }
  return records;
}

function crossrefDate(item) {
  const parts = (item["published-online"] ?? item.published ?? item.issued)?.["date-parts"]?.[0];
  // A year or month alone is not an exact first-publication date.
  return parts?.length === 3 ? `${parts[0]}-${String(parts[1]).padStart(2, "0")}-${String(parts[2]).padStart(2, "0")}T00:00:00.000Z` : null;
}

export function normalizeCrossrefWork(item, edition) {
  if (!(item["container-title"] ?? []).includes(edition.containerTitle)) return null;
  const doi = normalizeDoi(item.DOI);
  if (!doi || !item.title?.[0] || !item.author?.length) throw new Error("Crossref work is missing DOI/title/authors.");
  const publishedAt = crossrefDate(item);
  if (publishedAt && Number(publishedAt.slice(0, 4)) !== edition.year) return null;
  return { title: decodeHtml(item.title[0]), authors: item.author.map((author) => author.name ?? [author.given, author.family].filter(Boolean).join(" ")),
    abstract: decodeHtml(item.abstract ?? ""), publishedAt, updatedAt: null, sourceRecordId: doi,
    identifiers: { doi: [doi], arxiv: [], openReviewForum: [] },
    links: [{ label: "Paper", href: `https://doi.org/${doi}` },
      ...(item.link ?? []).filter((link) => link["content-type"] === "application/pdf").map((link) => ({ label: "PDF", href: link.URL }))] };
}

export async function discoverVenueProceedings(context = {}) {
  return discoverConferences("venue-proceedings", ["cvf", "crossref"], context, async (edition, ctx, status) => {
    if (edition.provider === "cvf") return parseCvfIndex(await fetchConference(edition.indexUrl, ctx, status, "html"), edition);
    const records = [], seen = new Set();
    let cursor = "*";
    for (;;) {
      const url = new URL("https://api.crossref.org/works");
      url.searchParams.set("filter", `container-title:${edition.containerTitle},from-pub-date:${edition.year}-01-01,until-pub-date:${edition.year}-12-31`);
      url.searchParams.set("rows", "1000");
      url.searchParams.set("cursor", cursor);
      const data = await fetchConference(url, ctx, status);
      const items = data.message?.items;
      if (!Array.isArray(items)) throw new Error("Crossref response has no items array.");
      for (const item of items) {
        if (seen.has(item.DOI)) throw new Error("Crossref pagination repeated a DOI.");
        seen.add(item.DOI);
        const record = normalizeCrossrefWork(item, edition);
        if (record) records.push(record);
      }
      if (items.length < 1000) {
        if (Number.isFinite(data.message["total-results"]) && seen.size < data.message["total-results"]) throw new Error("Crossref returned a truncated page.");
        break;
      }
      if (!data.message["next-cursor"]) throw new Error("Crossref pagination cursor is missing.");
      cursor = data.message["next-cursor"];
    }
    return records;
  });
}
