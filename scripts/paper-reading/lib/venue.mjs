function normalizeVenueText(value, policy) {
  if (typeof value !== "string") return "";
  let normalized = value.normalize("NFKC");
  if (policy.normalizeCase) normalized = normalized.toLocaleLowerCase("en-US");
  if (policy.stripPunctuation) normalized = normalized.replace(/[\p{P}\p{S}]+/gu, " ");
  if (policy.normalizeWhitespace) normalized = normalized.replace(/\s+/g, " ").trim();
  return normalized;
}
export function buildVenueAliasIndex(registry) {
  const index = new Map();
  const policy = registry.aliasMatching ?? {};

  for (const venue of registry.venues ?? []) {
    for (const alias of [venue.name, ...(venue.aliases ?? [])]) {
      const key = normalizeVenueText(alias, policy);
      if (!key) continue;
      const current = index.get(key) ?? [];
      current.push({ id: venue.id, name: venue.name, priority: venue.priority });
      index.set(key, current);
    }
  }

  return { index, policy };
}

export function matchVenueIds(candidate, venueAliasIndex) {
  const texts = [candidate.venueText, candidate.sourceNotes?.journalRef].filter(Boolean);
  const matches = new Map();
  for (const text of texts) {
    const key = normalizeVenueText(text, venueAliasIndex.policy);
    for (const venue of venueAliasIndex.index.get(key) ?? []) {
      matches.set(venue.id, venue);
    }
  }
  return [...matches.values()].sort((left, right) => left.id.localeCompare(right.id));
}
