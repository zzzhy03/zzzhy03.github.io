function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
function cleanText(value) {
  return decodeXml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function element(xml, name) {
  const match = xml.match(
    new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"),
  );
  return match ? cleanText(match[1]) : null;
}

function elements(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "gi"))]
    .map((match) => cleanText(match[1]))
    .filter(Boolean);
}

function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    result[match[1]] = decodeXml(match[2] ?? match[3] ?? "");
  }
  return result;
}

function integerElement(xml, name) {
  const value = element(xml, name);
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseArxivAtomFeed(xml) {
  if (typeof xml !== "string" || !xml.trim()) {
    throw new Error("arXiv response was empty.");
  }

  const entries = [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map(
    (match) => {
      const entry = match[1];
      const links = [...entry.matchAll(/<link\b[^>]*\/?\s*>/gi)].map((linkMatch) =>
        attributes(linkMatch[0]),
      );
      const categories = [...entry.matchAll(/<category\b[^>]*\/?\s*>/gi)]
        .map((categoryMatch) => attributes(categoryMatch[0]).term)
        .filter(Boolean);
      const primaryCategoryTag = entry.match(/<arxiv:primary_category\b[^>]*\/?\s*>/i);
      const id = element(entry, "id");

      return {
        id,
        title: element(entry, "title"),
        abstract: element(entry, "summary"),
        publishedAt: element(entry, "published"),
        updatedAt: element(entry, "updated"),
        authors: elements(entry, "name"),
        categories,
        primaryCategory: primaryCategoryTag
          ? attributes(primaryCategoryTag[0]).term ?? null
          : null,
        doi: element(entry, "arxiv:doi"),
        journalRef: element(entry, "arxiv:journal_ref"),
        comments: element(entry, "arxiv:comment"),
        links,
      };
    },
  );

  return {
    totalResults: integerElement(xml, "opensearch:totalResults"),
    startIndex: integerElement(xml, "opensearch:startIndex"),
    itemsPerPage: integerElement(xml, "opensearch:itemsPerPage"),
    entries,
  };
}
