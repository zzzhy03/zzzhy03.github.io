import { createHash } from "node:crypto";

function quoteArxivTerm(value) {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `all:"${escaped}"`;
}
function orGroup(values) {
  return values.length === 1 ? values[0] : `(${values.join(" OR ")})`;
}

function compileFamily(family) {
  const clauses = [];
  const exactPhrases = family.exactPhrases.map(quoteArxivTerm);
  if (exactPhrases.length) clauses.push(orGroup(exactPhrases));

  if (family.anchors.length && family.actions.length) {
    const anchors = orGroup(family.anchors.map(quoteArxivTerm));
    const actions = orGroup(family.actions.map(quoteArxivTerm));
    clauses.push(`(${anchors} AND ${actions})`);
  }

  return clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`;
}

export function compileArxivQueries(researchConfig, topicIds = null) {
  const selected = topicIds ? new Set(topicIds) : null;
  return researchConfig.directions
    .filter((direction) => !selected || selected.has(direction.id))
    .map((direction) => {
      const query = orGroup(direction.search.queryFamilies.map(compileFamily));
      return {
        id: createHash("sha256").update(`${direction.id}\n${query}`).digest("hex").slice(0, 16),
        topicId: direction.id,
        query,
        familyCount: direction.search.queryFamilies.length,
      };
    });
}

function includesTerm(text, term) {
  return text.includes(term.normalize("NFKC").toLocaleLowerCase("en-US"));
}

export function locallyMatchesDirection(record, direction) {
  const text = `${record.title ?? ""}\n${record.abstract ?? ""}`
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");

  return direction.search.queryFamilies.some((family) => {
    const exactMatch = family.exactPhrases.some((phrase) => includesTerm(text, phrase));
    const booleanMatch =
      family.anchors.some((anchor) => includesTerm(text, anchor)) &&
      family.actions.some((action) => includesTerm(text, action));
    return exactMatch || booleanMatch;
  });
}
