/**
 * Validate the static Paper Reading content before a production build.
 *
 * Input: content/paper-reading/topics.json, papers/*.json, and digests/*.json.
 * Output: exits non-zero with actionable schema/reference errors, otherwise prints counts.
 * Example: npm run validate:papers
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const contentRoot = path.join(root, "content", "paper-reading");
const allowed = {
  relevance: new Set(["high", "medium", "low"]),
  readingAction: new Set(["deep", "skim", "skip"]),
  evidenceMaturity: new Set(["solid", "mixed", "early"]),
  sourceScope: new Set(["full_text", "abstract", "metadata"]),
  digestMode: new Set(["preview", "daily", "backfill"]),
  sourceStatus: new Set(["checked", "partial", "failed"]),
  accent: new Set(["teal", "blue", "amber", "violet", "rose"]),
  linkLabel: new Set(["Paper", "Project", "Code", "DOI"]),
  publicationType: new Set(["peer-reviewed", "preprint", "technical-report"]),
  configStatus: new Set(["draft", "active"]),
  venueKind: new Set(["conference", "journal"]),
  venuePriority: new Set(["P0", "P1", "P2"]),
};

function fail(message) {
  throw new Error(`[paper-reading] ${message}`);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`Cannot parse ${path.relative(root, file)}: ${error.message}`);
  }
}

function readDirectory(directory) {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({ file, value: readJson(path.join(directory, file)) }));
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function requireText(value, context) {
  if (typeof value !== "string" || !value.trim()) fail(`${context} must be non-empty text.`);
}

function requireArray(value, context) {
  if (!Array.isArray(value)) fail(`${context} must be an array.`);
}

function requireBoolean(value, context) {
  if (typeof value !== "boolean") fail(`${context} must be a boolean.`);
}

function requireObject(value, context) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object.`);
  }
}

function requireNumber(value, context) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${context} must be a finite number.`);
  }
}

function requireKebabId(value, context) {
  requireText(value, context);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    fail(`${context} must be a lowercase kebab-case ID.`);
  }
}

function requireDate(value, context) {
  requireText(value, context);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    fail(`${context} must use a valid YYYY-MM-DD date.`);
  }
}

function requireTimestamp(value, context) {
  requireText(value, context);
  if (Number.isNaN(Date.parse(value))) fail(`${context} must be a valid ISO timestamp.`);
}

function requireSha256(value, context) {
  requireText(value, context);
  if (!/^[a-f0-9]{64}$/.test(value)) fail(`${context} must be a lowercase SHA-256.`);
}

function requireHttpsUrl(value, context) {
  requireText(value, context);
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") fail(`${context} must use HTTPS.`);
  } catch {
    fail(`${context} must be a valid HTTPS URL.`);
  }
}

function requireTextArray(value, context, { allowEmpty = false } = {}) {
  requireArray(value, context);
  if (!allowEmpty && value.length === 0) fail(`${context} must not be empty.`);
  value.forEach((item, index) => requireText(item, `${context}[${index}]`));
}

function requireUniqueTextArray(value, context, options = {}) {
  requireTextArray(value, context, options);
  const normalized = value.map((item) => item.trim().toLocaleLowerCase("en-US"));
  if (new Set(normalized).size !== normalized.length) {
    fail(`${context} must not contain duplicate values.`);
  }
}

function requireKnownKeys(value, allowedKeys, context) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) fail(`${context} contains unsupported field '${key}'.`);
  }
}

const topics = readJson(path.join(contentRoot, "topics.json"));
const researchConfig = readJson(path.join(contentRoot, "research-config.json"));
const venueRegistry = readJson(path.join(contentRoot, "venue-registry.json"));
const paperEntries = readDirectory(path.join(contentRoot, "papers"));
const digestEntries = readDirectory(path.join(contentRoot, "digests"));
const runReceiptDirectory = path.join(contentRoot, "runs");
const runReceiptEntries = existsSync(runReceiptDirectory)
  ? readDirectory(runReceiptDirectory)
  : [];

requireArray(topics, "topics.json");
const topicIds = new Set();
for (const topic of topics) {
  requireText(topic.id, "topic.id");
  if (topicIds.has(topic.id)) fail(`Duplicate topic ID '${topic.id}'.`);
  topicIds.add(topic.id);
  requireText(topic.labelZh, `${topic.id}.labelZh`);
  requireText(topic.labelEn, `${topic.id}.labelEn`);
  requireText(topic.shortLabel, `${topic.id}.shortLabel`);
  requireText(topic.descriptionZh, `${topic.id}.descriptionZh`);
  if (!allowed.accent.has(topic.accent)) fail(`${topic.id}.accent has an unsupported value.`);
}

requireObject(researchConfig, "research-config.json");
if (researchConfig.schemaVersion !== 1) {
  fail("research-config.json.schemaVersion must equal 1.");
}
if (!allowed.configStatus.has(researchConfig.status)) {
  fail("research-config.json.status must be 'draft' or 'active'.");
}
requireDate(researchConfig.reviewedAt, "research-config.json.reviewedAt");
requireText(researchConfig.purposeZh, "research-config.json.purposeZh");
requireObject(researchConfig.ui, "research-config.json.ui");
requireText(researchConfig.ui.groupingStatus, "research-config.json.ui.groupingStatus");
requireUniqueTextArray(
  researchConfig.ui.directionOrder,
  "research-config.json.ui.directionOrder",
);
requireObject(researchConfig.discoveryDefaults, "research-config.json.discoveryDefaults");
if (
  researchConfig.discoveryDefaults.dailyQuota !== null &&
  (!Number.isInteger(researchConfig.discoveryDefaults.dailyQuota) ||
    researchConfig.discoveryDefaults.dailyQuota <= 0)
) {
  fail("research-config.json.discoveryDefaults.dailyQuota must be null or a positive integer.");
}
requireText(researchConfig.discoveryDefaults.quotaPolicy, "research-config.json.discoveryDefaults.quotaPolicy");
requireBoolean(
  researchConfig.discoveryDefaults.requireTechnicalContribution,
  "research-config.json.discoveryDefaults.requireTechnicalContribution",
);
requireBoolean(
  researchConfig.discoveryDefaults.negativeSignalsAreContextual,
  "research-config.json.discoveryDefaults.negativeSignalsAreContextual",
);
requireBoolean(
  researchConfig.discoveryDefaults.allowEmptyDirectionBriefs,
  "research-config.json.discoveryDefaults.allowEmptyDirectionBriefs",
);
requireUniqueTextArray(
  researchConfig.discoveryDefaults.publicationTypes,
  "research-config.json.discoveryDefaults.publicationTypes",
);
for (const publicationType of researchConfig.discoveryDefaults.publicationTypes) {
  if (!allowed.publicationType.has(publicationType)) {
    fail(
      `research-config.json.discoveryDefaults.publicationTypes contains unsupported value '${publicationType}'.`,
    );
  }
}
if (
  researchConfig.discoveryDefaults.publicationTypes.length !== allowed.publicationType.size ||
  [...allowed.publicationType].some(
    (publicationType) =>
      !researchConfig.discoveryDefaults.publicationTypes.includes(publicationType),
  )
) {
  fail(
    "research-config.json.discoveryDefaults.publicationTypes must contain every supported publication type exactly once.",
  );
}
requireText(
  researchConfig.discoveryDefaults.queryCompilerZh,
  "research-config.json.discoveryDefaults.queryCompilerZh",
);

requireObject(researchConfig.attentionPolicies, "research-config.json.attentionPolicies");
const attentionPolicyIds = new Set(Object.keys(researchConfig.attentionPolicies));
if (attentionPolicyIds.size === 0) {
  fail("research-config.json.attentionPolicies must not be empty.");
}
for (const [policyId, policy] of Object.entries(researchConfig.attentionPolicies)) {
  requireKebabId(policyId, `research-config.json.attentionPolicies.${policyId}`);
  requireObject(policy, `research-config.json.attentionPolicies.${policyId}`);
  requireText(policy.labelZh, `${policyId}.labelZh`);
  requireText(policy.gateZh, `${policyId}.gateZh`);
  requireBoolean(policy.allowIncremental, `${policyId}.allowIncremental`);
  requireBoolean(policy.allowPreprints, `${policyId}.allowPreprints`);
  requireBoolean(policy.allowOfficialTechnicalReports, `${policyId}.allowOfficialTechnicalReports`);
  requireText(policy.venueRole, `${policyId}.venueRole`);
}

requireArray(researchConfig.directions, "research-config.json.directions");
if (researchConfig.directions.length === 0) {
  fail("research-config.json.directions must not be empty.");
}
const researchDirectionIds = new Set();
const researchDirectionsById = new Map();
const pendingCrossTopicHints = [];
for (const direction of researchConfig.directions) {
  requireObject(direction, "research-config.json.direction");
  requireKebabId(direction.id, "research-config.json.direction.id");
  if (researchDirectionIds.has(direction.id)) {
    fail(`Duplicate research direction ID '${direction.id}'.`);
  }
  researchDirectionIds.add(direction.id);
  researchDirectionsById.set(direction.id, direction);
  requireText(direction.labelZh, `${direction.id}.labelZh`);
  requireText(direction.labelEn, `${direction.id}.labelEn`);
  requireText(direction.shortLabel, `${direction.id}.shortLabel`);
  requireText(direction.descriptionZh, `${direction.id}.descriptionZh`);
  if (!allowed.accent.has(direction.accent)) {
    fail(`${direction.id}.accent has an unsupported value.`);
  }
  if (!attentionPolicyIds.has(direction.attentionPolicy)) {
    fail(`${direction.id} references unknown attention policy '${direction.attentionPolicy}'.`);
  }
  requireObject(direction.search, `${direction.id}.search`);
  requireArray(direction.search.queryFamilies, `${direction.id}.search.queryFamilies`);
  if (direction.search.queryFamilies.length === 0) {
    fail(`${direction.id}.search.queryFamilies must not be empty.`);
  }
  direction.search.queryFamilies.forEach((family, familyIndex) => {
    const context = `${direction.id}.search.queryFamilies[${familyIndex}]`;
    requireObject(family, context);
    requireUniqueTextArray(family.anchors, `${context}.anchors`, { allowEmpty: true });
    requireUniqueTextArray(family.actions, `${context}.actions`, { allowEmpty: true });
    requireUniqueTextArray(family.exactPhrases, `${context}.exactPhrases`, { allowEmpty: true });
    const hasBooleanQuery = family.anchors.length > 0 && family.actions.length > 0;
    const hasExactQuery = family.exactPhrases.length > 0;
    if (!hasBooleanQuery && !hasExactQuery) {
      fail(`${context} must provide exactPhrases or both anchors and actions.`);
    }
  });
  requireUniqueTextArray(
    direction.search.hardNegativeSignals,
    `${direction.id}.search.hardNegativeSignals`,
    { allowEmpty: true },
  );
  requireUniqueTextArray(
    direction.search.conditionalNegativeSignals,
    `${direction.id}.search.conditionalNegativeSignals`,
    { allowEmpty: true },
  );
  requireUniqueTextArray(direction.includeWhenZh, `${direction.id}.includeWhenZh`);
  requireUniqueTextArray(direction.excludeWhenZh, `${direction.id}.excludeWhenZh`);
  requireArray(direction.crossTopicHints, `${direction.id}.crossTopicHints`);
  for (const [hintIndex, hint] of direction.crossTopicHints.entries()) {
    requireObject(hint, `${direction.id}.crossTopicHints[${hintIndex}]`);
    requireKebabId(hint.topicId, `${direction.id}.crossTopicHints[${hintIndex}].topicId`);
    requireText(hint.whenZh, `${direction.id}.crossTopicHints[${hintIndex}].whenZh`);
    pendingCrossTopicHints.push({ sourceId: direction.id, targetId: hint.topicId });
  }
}

if (
  researchConfig.ui.directionOrder.length !== researchDirectionIds.size ||
  researchConfig.ui.directionOrder.some((directionId) => !researchDirectionIds.has(directionId))
) {
  fail("research-config.json.ui.directionOrder must contain every research direction exactly once.");
}
if (researchConfig.status === "active") {
  if (topics.length !== researchConfig.ui.directionOrder.length) {
    fail("Active research config requires topics.json to expose every research direction.");
  }
  for (const [index, directionId] of researchConfig.ui.directionOrder.entries()) {
    const topic = topics[index];
    const direction = researchDirectionsById.get(directionId);
    if (topic?.id !== directionId) {
      fail("topics.json order must match active research-config.json.ui.directionOrder.");
    }
    for (const field of ["labelZh", "labelEn", "shortLabel", "descriptionZh", "accent"]) {
      if (topic[field] !== direction[field]) {
        fail(`topics.json '${directionId}.${field}' must match the active research direction.`);
      }
    }
  }
}
for (const { sourceId, targetId } of pendingCrossTopicHints) {
  if (!researchDirectionIds.has(targetId)) {
    fail(`${sourceId} contains a cross-topic hint for unknown direction '${targetId}'.`);
  }
  if (sourceId === targetId) {
    fail(`${sourceId} must not contain a cross-topic hint to itself.`);
  }
}

requireObject(researchConfig.tagTaxonomy, "research-config.json.tagTaxonomy");
requireText(
  researchConfig.tagTaxonomy.displayPolicyZh,
  "research-config.json.tagTaxonomy.displayPolicyZh",
);
requireArray(researchConfig.tagTaxonomy.dimensions, "research-config.json.tagTaxonomy.dimensions");
const facetDimensionIds = new Set();
const facetValuesByDimension = new Map();
for (const dimension of researchConfig.tagTaxonomy.dimensions) {
  requireKebabId(dimension.id, "research-config.json.tagTaxonomy.dimension.id");
  if (facetDimensionIds.has(dimension.id)) {
    fail(`Duplicate facet dimension ID '${dimension.id}'.`);
  }
  facetDimensionIds.add(dimension.id);
  requireText(dimension.labelZh, `${dimension.id}.labelZh`);
  requireArray(dimension.values, `${dimension.id}.values`);
  if (dimension.values.length === 0) fail(`${dimension.id}.values must not be empty.`);
  const facetValueIds = new Set();
  for (const value of dimension.values) {
    requireKebabId(value.id, `${dimension.id}.value.id`);
    if (facetValueIds.has(value.id)) {
      fail(`Duplicate facet value '${value.id}' in '${dimension.id}'.`);
    }
    facetValueIds.add(value.id);
    requireText(value.label, `${dimension.id}.${value.id}.label`);
  }
  facetValuesByDimension.set(dimension.id, facetValueIds);
}

for (const [field, itemLabel] of [
  ["routingRules", "routing rule"],
  ["globalExclusions", "global exclusion"],
]) {
  requireArray(researchConfig[field], `research-config.json.${field}`);
  const ids = new Set();
  for (const item of researchConfig[field]) {
    requireKebabId(item.id, `${itemLabel}.id`);
    if (ids.has(item.id)) fail(`Duplicate ${itemLabel} ID '${item.id}'.`);
    ids.add(item.id);
    if (field === "routingRules") {
      requireText(item.ruleZh, `${item.id}.ruleZh`);
    } else {
      requireText(item.labelZh, `${item.id}.labelZh`);
      requireUniqueTextArray(item.signals, `${item.id}.signals`);
    }
  }
}

requireObject(researchConfig.deduplication, "research-config.json.deduplication");
requireBoolean(
  researchConfig.deduplication.neverRekeyExistingPaper,
  "research-config.json.deduplication.neverRekeyExistingPaper",
);
requireUniqueTextArray(
  researchConfig.deduplication.identityOrder,
  "research-config.json.deduplication.identityOrder",
);
requireUniqueTextArray(
  researchConfig.deduplication.meaningfulUpdateFields,
  "research-config.json.deduplication.meaningfulUpdateFields",
);
requireObject(researchConfig.deduplication.manualReview, "research-config.json.deduplication.manualReview");
requireNumber(
  researchConfig.deduplication.manualReview.fuzzyTitleSimilarity,
  "research-config.json.deduplication.manualReview.fuzzyTitleSimilarity",
);
requireText(researchConfig.deduplication.updatePolicyZh, "research-config.json.deduplication.updatePolicyZh");

requireObject(researchConfig.library, "research-config.json.library");
requireText(researchConfig.library.status, "research-config.json.library.status");
requireText(researchConfig.library.route, "research-config.json.library.route");
if (!researchConfig.library.route.startsWith("/paper_reading/")) {
  fail("research-config.json.library.route must stay under /paper_reading/.");
}
if (!Number.isInteger(researchConfig.library.pageSize) || researchConfig.library.pageSize <= 0) {
  fail("research-config.json.library.pageSize must be a positive integer.");
}
requireBoolean(
  researchConfig.library.urlSynchronizedFilters,
  "research-config.json.library.urlSynchronizedFilters",
);
for (const field of [
  "paperFields",
  "searchFields",
  "filterFields",
  "sortFields",
]) {
  requireUniqueTextArray(researchConfig.library[field], `research-config.json.library.${field}`);
}
requireObject(
  researchConfig.library.viewResponsibilitiesZh,
  "research-config.json.library.viewResponsibilitiesZh",
);
for (const view of ["daily", "library", "readingList"]) {
  requireText(
    researchConfig.library.viewResponsibilitiesZh[view],
    `research-config.json.library.viewResponsibilitiesZh.${view}`,
  );
}

if (researchConfig.status === "active") {
  if (
    topicIds.size !== researchDirectionIds.size ||
    [...researchDirectionIds].some((directionId) => !topicIds.has(directionId))
  ) {
    fail("An active research config requires topics.json to match all configured directions.");
  }
}

requireObject(venueRegistry, "venue-registry.json");
if (venueRegistry.schemaVersion !== 1) {
  fail("venue-registry.json.schemaVersion must equal 1.");
}
if (!allowed.configStatus.has(venueRegistry.status)) {
  fail("venue-registry.json.status must be 'draft' or 'active'.");
}
requireDate(venueRegistry.reviewedAt, "venue-registry.json.reviewedAt");
requireText(venueRegistry.policyZh, "venue-registry.json.policyZh");
requireObject(venueRegistry.aliasMatching, "venue-registry.json.aliasMatching");
for (const field of [
  "normalizeCase",
  "normalizeWhitespace",
  "stripPunctuation",
  "allowFreeTextSubstringMatch",
]) {
  requireBoolean(venueRegistry.aliasMatching[field], `venue-registry.json.aliasMatching.${field}`);
}
requireText(venueRegistry.aliasMatching.matchMode, "venue-registry.json.aliasMatching.matchMode");
requireObject(venueRegistry.priorityDefinitions, "venue-registry.json.priorityDefinitions");
for (const priority of allowed.venuePriority) {
  requireText(venueRegistry.priorityDefinitions[priority], `venue-registry.json.priorityDefinitions.${priority}`);
}
requireObject(venueRegistry.scanPolicies, "venue-registry.json.scanPolicies");
const scanPolicyIds = new Set(Object.keys(venueRegistry.scanPolicies));
if (scanPolicyIds.size === 0) fail("venue-registry.json.scanPolicies must not be empty.");
for (const [scanPolicyId, description] of Object.entries(venueRegistry.scanPolicies)) {
  requireKebabId(scanPolicyId, `venue-registry.json.scanPolicies.${scanPolicyId}`);
  requireText(description, `venue-registry.json.scanPolicies.${scanPolicyId}`);
}

requireArray(venueRegistry.venues, "venue-registry.json.venues");
const venueIds = new Set();
const normalizedVenueAliases = new Map();
const normalizeVenueAlias = (value) => value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim();
for (const venue of venueRegistry.venues) {
  requireKebabId(venue.id, "venue-registry.json.venue.id");
  if (venueIds.has(venue.id)) fail(`Duplicate venue ID '${venue.id}'.`);
  venueIds.add(venue.id);
  requireText(venue.name, `${venue.id}.name`);
  requireUniqueTextArray(venue.aliases, `${venue.id}.aliases`);
  if (!allowed.venueKind.has(venue.kind)) fail(`${venue.id}.kind has an unsupported value.`);
  if (!allowed.venuePriority.has(venue.priority)) {
    fail(`${venue.id}.priority has an unsupported value.`);
  }
  if (!scanPolicyIds.has(venue.scanPolicy)) {
    fail(`${venue.id} references unknown scan policy '${venue.scanPolicy}'.`);
  }
  requireUniqueTextArray(venue.primaryTopicIds, `${venue.id}.primaryTopicIds`, { allowEmpty: true });
  requireUniqueTextArray(venue.secondaryTopicIds, `${venue.id}.secondaryTopicIds`, { allowEmpty: true });
  const primaryTopicIds = new Set(venue.primaryTopicIds);
  for (const topicId of [...venue.primaryTopicIds, ...venue.secondaryTopicIds]) {
    if (!researchDirectionIds.has(topicId)) {
      fail(`${venue.id} references unknown research direction '${topicId}'.`);
    }
  }
  for (const topicId of venue.secondaryTopicIds) {
    if (primaryTopicIds.has(topicId)) {
      fail(`${venue.id} lists '${topicId}' as both primary and secondary.`);
    }
  }
  for (const alias of [venue.name, ...venue.aliases]) {
    const normalized = normalizeVenueAlias(alias);
    const previousVenueId = normalizedVenueAliases.get(normalized);
    if (previousVenueId && previousVenueId !== venue.id) {
      fail(`Venue alias '${alias}' is shared by '${previousVenueId}' and '${venue.id}'.`);
    }
    normalizedVenueAliases.set(normalized, venue.id);
  }
}

requireArray(venueRegistry.globalPolicyOverrides, "venue-registry.json.globalPolicyOverrides");
const venueOverrideIds = new Set();
for (const override of venueRegistry.globalPolicyOverrides) {
  requireKebabId(override.id, "venue policy override.id");
  if (venueOverrideIds.has(override.id)) fail(`Duplicate venue policy override '${override.id}'.`);
  venueOverrideIds.add(override.id);
  requireNumber(override.priority, `${override.id}.priority`);
  requireUniqueTextArray(override.topicIds, `${override.id}.topicIds`);
  for (const topicId of override.topicIds) {
    if (topicId !== "*" && !researchDirectionIds.has(topicId)) {
      fail(`${override.id} references unknown research direction '${topicId}'.`);
    }
  }
  requireText(override.venueRequirement, `${override.id}.venueRequirement`);
  requireText(override.admitWhenZh, `${override.id}.admitWhenZh`);
}

requireArray(venueRegistry.nonVenueSources, "venue-registry.json.nonVenueSources");
const nonVenueSourceIds = new Set();
for (const source of venueRegistry.nonVenueSources) {
  requireKebabId(source.id, "non-venue source.id");
  if (nonVenueSourceIds.has(source.id)) fail(`Duplicate non-venue source '${source.id}'.`);
  nonVenueSourceIds.add(source.id);
  requireText(source.name, `${source.id}.name`);
  requireText(source.kind, `${source.id}.kind`);
  requireUniqueTextArray(source.admitIfAnyZh, `${source.id}.admitIfAnyZh`);
  requireUniqueTextArray(source.requiredChecksZh, `${source.id}.requiredChecksZh`);
  if (source.primaryTopicIds !== undefined) {
    requireUniqueTextArray(source.primaryTopicIds, `${source.id}.primaryTopicIds`);
    for (const topicId of source.primaryTopicIds) {
      if (!researchDirectionIds.has(topicId)) {
        fail(`${source.id} references unknown research direction '${topicId}'.`);
      }
    }
  }
}

requireObject(venueRegistry.dedupe, "venue-registry.json.dedupe");
requireArray(venueRegistry.dedupe.publicationFamilies, "venue-registry.json.dedupe.publicationFamilies");
const publicationFamilyIds = new Set();
for (const family of venueRegistry.dedupe.publicationFamilies) {
  requireKebabId(family.id, "venue publication family.id");
  if (publicationFamilyIds.has(family.id)) fail(`Duplicate publication family '${family.id}'.`);
  publicationFamilyIds.add(family.id);
  requireUniqueTextArray(family.eventVenueIds, `${family.id}.eventVenueIds`);
  requireUniqueTextArray(family.publicationVenueIds, `${family.id}.publicationVenueIds`);
  for (const venueId of [...family.eventVenueIds, ...family.publicationVenueIds]) {
    if (!venueIds.has(venueId)) fail(`${family.id} references unknown venue '${venueId}'.`);
  }
  requireText(family.guardZh, `${family.id}.guardZh`);
}
requireUniqueTextArray(venueRegistry.dedupe.mergeWhenAny, "venue-registry.json.dedupe.mergeWhenAny");
requireText(venueRegistry.dedupe.metadataPolicyZh, "venue-registry.json.dedupe.metadataPolicyZh");

const paperIds = new Set();
const paperSlugs = new Set();
const paperTopics = new Map();
const paperFilesById = new Map();
const identifierOwners = {
  doi: new Map(),
  arxiv: new Map(),
  openReviewForum: new Map(),
};
for (const { file, value: paper } of paperEntries) {
  requireText(paper.id, `${file}.id`);
  requireText(paper.slug, `${file}.slug`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(paper.slug)) {
    fail(`${file}.slug must be a lowercase URL-safe slug.`);
  }
  if (`${paper.slug}.json` !== file) fail(`${file} must match its paper slug.`);
  if (paperSlugs.has(paper.slug)) fail(`Duplicate paper slug '${paper.slug}'.`);
  paperSlugs.add(paper.slug);
  requireText(paper.title, `${file}.title`);
  requireDate(paper.publishedAt, `${file}.publishedAt`);
  if (paper.updatedAt !== undefined) requireDate(paper.updatedAt, `${file}.updatedAt`);
  requireDate(paper.collectedAt, `${file}.collectedAt`);
  requireText(paper.venue, `${file}.venue`);
  if (paper.identifiers !== undefined) {
    requireObject(paper.identifiers, `${file}.identifiers`);
    requireKnownKeys(
      paper.identifiers,
      new Set(["doi", "arxiv", "openReviewForum"]),
      `${file}.identifiers`,
    );
    for (const [identifierType, identifierValue] of Object.entries(paper.identifiers)) {
      requireText(identifierValue, `${file}.identifiers.${identifierType}`);
      if (
        identifierType === "doi" &&
        !/^10\.\d{4,9}\/\S+$/i.test(identifierValue)
      ) {
        fail(`${file}.identifiers.doi must be a bare DOI, not a URL.`);
      }
      if (
        identifierType === "arxiv" &&
        !/^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]+\/\d{7})$/i.test(identifierValue)
      ) {
        fail(`${file}.identifiers.arxiv must be a versionless arXiv ID.`);
      }
      const normalizedIdentifier =
        identifierType === "openReviewForum"
          ? identifierValue
          : identifierValue.toLocaleLowerCase("en-US");
      const previousOwner = identifierOwners[identifierType].get(normalizedIdentifier);
      if (previousOwner && previousOwner !== paper.id) {
        fail(
          `${file}.identifiers.${identifierType} duplicates the identifier owned by '${previousOwner}'.`,
        );
      }
      identifierOwners[identifierType].set(normalizedIdentifier, paper.id);
    }
  }
  if (paper.venueIds !== undefined) {
    requireUniqueTextArray(paper.venueIds, `${file}.venueIds`, { allowEmpty: true });
    for (const venueId of paper.venueIds) {
      if (!venueIds.has(venueId)) fail(`${file} references unknown venue '${venueId}'.`);
    }
  }
  if (
    paper.publicationType !== undefined &&
    !allowed.publicationType.has(paper.publicationType)
  ) {
    fail(`${file}.publicationType has an unsupported value.`);
  }
  requireText(paper.abstract, `${file}.abstract`);
  requireBoolean(paper.abstractIsOriginal, `${file}.abstractIsOriginal`);
  requireHttpsUrl(paper.abstractSourceUrl, `${file}.abstractSourceUrl`);
  if (paperIds.has(paper.id)) fail(`Duplicate paper ID '${paper.id}'.`);
  paperIds.add(paper.id);
  paperFilesById.set(paper.id, path.join(contentRoot, "papers", file));
  requireTextArray(paper.authors, `${file}.authors`);
  requireTextArray(paper.categories, `${file}.categories`);
  requireUniqueTextArray(paper.topicIds, `${file}.topicIds`);
  if (paper.primaryTopicId !== undefined) {
    requireText(paper.primaryTopicId, `${file}.primaryTopicId`);
    if (!paper.topicIds.includes(paper.primaryTopicId)) {
      fail(`${file}.primaryTopicId must also appear in topicIds.`);
    }
  }
  requireTextArray(paper.keywords, `${file}.keywords`);
  if (paper.facets !== undefined) {
    requireObject(paper.facets, `${file}.facets`);
    for (const [dimensionId, valueIds] of Object.entries(paper.facets)) {
      const allowedValueIds = facetValuesByDimension.get(dimensionId);
      if (!allowedValueIds) fail(`${file}.facets references unknown dimension '${dimensionId}'.`);
      requireUniqueTextArray(valueIds, `${file}.facets.${dimensionId}`);
      for (const valueId of valueIds) {
        if (!allowedValueIds.has(valueId)) {
          fail(`${file}.facets.${dimensionId} references unknown value '${valueId}'.`);
        }
      }
    }
  }
  paperTopics.set(paper.id, new Set(paper.topicIds));
  requireArray(paper.links, `${file}.links`);
  if (paper.links.length === 0) fail(`${file}.links must include at least the paper URL.`);
  if (!paper.links.some((link) => link.label === "Paper")) {
    fail(`${file}.links must include a Paper link.`);
  }
  requireArray(paper.analysis?.methodFlow, `${file}.analysis.methodFlow`);
  if (paper.analysis.methodFlow.length < 2 || paper.analysis.methodFlow.length > 6) {
    fail(`${file}.analysis.methodFlow must contain 2-6 steps.`);
  }
  for (const topicId of paper.topicIds) {
    if (!topicIds.has(topicId)) fail(`${file} references unknown topic '${topicId}'.`);
  }
  for (const [field, values] of [
    ["relevance", allowed.relevance],
    ["readingAction", allowed.readingAction],
    ["evidenceMaturity", allowed.evidenceMaturity],
    ["sourceScope", allowed.sourceScope],
  ]) {
    if (!values.has(paper.analysis?.[field])) {
      fail(`${file}.analysis.${field} has an unsupported value.`);
    }
  }
  for (const link of paper.links) {
    if (!allowed.linkLabel.has(link.label)) fail(`${file} contains an unsupported link label.`);
    requireHttpsUrl(link.href, `${file}.links.${link.label}`);
  }
  for (const field of [
    "sourceNote",
    "ideaZh",
    "motivationZh",
    "methodZh",
    "experimentsZh",
    "insightZh",
  ]) {
    requireText(paper.analysis?.[field], `${file}.analysis.${field}`);
  }
  for (const field of ["whyRelevantZh", "evidenceZh", "caveatZh"]) {
    if (paper.analysis?.[field] !== undefined) {
      requireText(paper.analysis[field], `${file}.analysis.${field}`);
    }
  }
  if (paper.visual !== undefined) {
    requireText(paper.visual.src, `${file}.visual.src`);
    if (!paper.visual.src.startsWith("/paper-reading/figures/")) {
      fail(`${file}.visual.src must stay under /paper-reading/figures/.`);
    }
    requireText(paper.visual.alt, `${file}.visual.alt`);
    requireText(paper.visual.caption, `${file}.visual.caption`);
    requireBoolean(paper.visual.generated, `${file}.visual.generated`);
    const visualPath = path.join(root, "public", paper.visual.src.replace(/^\//, ""));
    if (!existsSync(visualPath)) fail(`${file} references missing visual '${paper.visual.src}'.`);
  }
}

const digestDates = new Set();
const digestFilesByDate = new Map();
for (const { file, value: digest } of digestEntries) {
  requireDate(digest.date, `${file}.date`);
  requireTimestamp(digest.generatedAt, `${file}.generatedAt`);
  if (`${digest.date}.json` !== file) fail(`${file} must match its digest date.`);
  if (digestDates.has(digest.date)) fail(`Duplicate digest date '${digest.date}'.`);
  digestDates.add(digest.date);
  digestFilesByDate.set(digest.date, path.join(contentRoot, "digests", file));
  if (!allowed.digestMode.has(digest.mode)) fail(`${file}.mode has an unsupported value.`);
  requireArray(digest.paperIds, `${file}.paperIds`);
  requireArray(digest.topicBriefs, `${file}.topicBriefs`);
  requireArray(digest.sourceStatus, `${file}.sourceStatus`);
  if (digest.sourceStatus.length === 0) fail(`${file}.sourceStatus must not be empty.`);
  requireText(digest.overview?.headlineZh, `${file}.overview.headlineZh`);
  requireTextArray(digest.overview?.bulletsZh, `${file}.overview.bulletsZh`);
  const digestPaperIds = new Set(digest.paperIds);
  if (digestPaperIds.size !== digest.paperIds.length) fail(`${file} has duplicate paper IDs.`);
  for (const paperId of digest.paperIds) {
    if (!paperIds.has(paperId)) fail(`${file} references unknown paper '${paperId}'.`);
  }
  const briefTopicIds = new Set();
  for (const brief of digest.topicBriefs) {
    if (!topicIds.has(brief.topicId)) {
      fail(`${file} contains a brief for unknown topic '${brief.topicId}'.`);
    }
    if (briefTopicIds.has(brief.topicId)) {
      fail(`${file} contains more than one brief for topic '${brief.topicId}'.`);
    }
    briefTopicIds.add(brief.topicId);
    requireText(brief.headlineZh, `${file}.${brief.topicId}.headlineZh`);
    requireText(brief.summaryZh, `${file}.${brief.topicId}.summaryZh`);
    requireArray(brief.paperIds, `${file}.${brief.topicId}.paperIds`);
    if (new Set(brief.paperIds).size !== brief.paperIds.length) {
      fail(`${file} brief '${brief.topicId}' has duplicate paper IDs.`);
    }
    for (const paperId of brief.paperIds) {
      if (!digestPaperIds.has(paperId)) {
        fail(`${file} brief '${brief.topicId}' references paper '${paperId}' outside the digest.`);
      }
      if (!paperTopics.get(paperId)?.has(brief.topicId)) {
        fail(`${file} brief '${brief.topicId}' references paper '${paperId}' without that topic.`);
      }
    }
  }
  for (const topicId of topicIds) {
    if (!briefTopicIds.has(topicId)) {
      fail(`${file} is missing the required 30-second brief for topic '${topicId}'.`);
    }
  }
  for (const source of digest.sourceStatus) {
    requireText(source.label, `${file}.sourceStatus.label`);
    requireText(source.noteZh, `${file}.${source.label}.noteZh`);
    if (!allowed.sourceStatus.has(source.status)) {
      fail(`${file} contains an unsupported source status.`);
    }
  }
}

for (const { file, value: receipt } of runReceiptEntries) {
  const context = `runs/${file}`;
  if (receipt.schemaVersion !== 1) fail(`${context}.schemaVersion must equal 1.`);
  if (receipt.kind !== "paper-reading-run-receipt") {
    fail(`${context}.kind must be 'paper-reading-run-receipt'.`);
  }
  requireText(receipt.runId, `${context}.runId`);
  requireDate(receipt.digestDate, `${context}.digestDate`);
  requireTimestamp(receipt.generatedAt, `${context}.generatedAt`);
  if (`${receipt.digestDate}.json` !== file) {
    fail(`${context} filename must match digestDate.`);
  }
  if (receipt.status !== "content-verified") {
    fail(`${context}.status must be 'content-verified'.`);
  }
  if (!new Set(["all-full-text", "high-deep"]).has(receipt.selection)) {
    fail(`${context}.selection has an unsupported value.`);
  }
  const digestFile = digestFilesByDate.get(receipt.digestDate);
  if (!digestFile) fail(`${context} references a missing digest.`);
  requireObject(receipt.digest, `${context}.digest`);
  requireText(receipt.digest.file, `${context}.digest.file`);
  requireSha256(receipt.digest.sha256, `${context}.digest.sha256`);
  if (receipt.digest.file !== path.relative(root, digestFile)) {
    fail(`${context}.digest.file must point to its canonical digest.`);
  }
  if (receipt.digest.sha256 !== sha256File(digestFile)) {
    fail(`${context}.digest.sha256 no longer matches its canonical digest.`);
  }

  requireObject(receipt.discovery, `${context}.discovery`);
  requireObject(receipt.discovery.window, `${context}.discovery.window`);
  requireTimestamp(receipt.discovery.window.start, `${context}.discovery.window.start`);
  requireTimestamp(receipt.discovery.window.end, `${context}.discovery.window.end`);
  requireObject(receipt.discovery.sources, `${context}.discovery.sources`);
  for (const [sourceId, status] of Object.entries(receipt.discovery.sources)) {
    requireText(sourceId, `${context}.discovery.sources source ID`);
    requireText(status, `${context}.discovery.sources.${sourceId}`);
  }
  if (!Number.isInteger(receipt.discovery.candidates) || receipt.discovery.candidates < 0) {
    fail(`${context}.discovery.candidates must be a non-negative integer.`);
  }
  for (const field of ["manifest", "candidateArtifact"]) {
    requireObject(receipt.discovery[field], `${context}.discovery.${field}`);
    requireText(receipt.discovery[field].file, `${context}.discovery.${field}.file`);
    requireSha256(receipt.discovery[field].sha256, `${context}.discovery.${field}.sha256`);
  }

  requireObject(receipt.screening, `${context}.screening`);
  requireObject(receipt.screening.decisions, `${context}.screening.decisions`);
  requireArray(receipt.screening.reviews, `${context}.screening.reviews`);
  for (const [index, artifact] of receipt.screening.reviews.entries()) {
    requireText(artifact.file, `${context}.screening.reviews[${index}].file`);
    requireSha256(artifact.sha256, `${context}.screening.reviews[${index}].sha256`);
  }

  requireObject(receipt.fulltext, `${context}.fulltext`);
  requireObject(receipt.fulltext.decisions, `${context}.fulltext.decisions`);
  requireArray(receipt.fulltext.reviews, `${context}.fulltext.reviews`);
  for (const [index, artifact] of receipt.fulltext.reviews.entries()) {
    requireText(artifact.paperId, `${context}.fulltext.reviews[${index}].paperId`);
    requireText(artifact.arxivVersion, `${context}.fulltext.reviews[${index}].arxivVersion`);
    requireText(artifact.decision, `${context}.fulltext.reviews[${index}].decision`);
    requireText(artifact.file, `${context}.fulltext.reviews[${index}].file`);
    requireSha256(artifact.sha256, `${context}.fulltext.reviews[${index}].sha256`);
  }
  requireObject(receipt.fulltext.backlog, `${context}.fulltext.backlog`);
  requireUniqueTextArray(
    receipt.fulltext.backlog.candidateIds,
    `${context}.fulltext.backlog.candidateIds`,
    { allowEmpty: true },
  );
  const backlogHasFile = Object.hasOwn(receipt.fulltext.backlog, "file");
  const backlogHasHash = Object.hasOwn(receipt.fulltext.backlog, "sha256");
  if (backlogHasFile !== backlogHasHash) {
    fail(`${context}.fulltext.backlog must contain both file and sha256 or neither.`);
  }
  if (receipt.fulltext.backlog.candidateIds.length > 0 && !backlogHasFile) {
    fail(`${context}.fulltext.backlog must reference an artifact when it is non-empty.`);
  }
  if (backlogHasFile) {
    requireText(receipt.fulltext.backlog.file, `${context}.fulltext.backlog.file`);
    requireSha256(receipt.fulltext.backlog.sha256, `${context}.fulltext.backlog.sha256`);
  }

  requireArray(receipt.canonicalPapers, `${context}.canonicalPapers`);
  const digestPaperIds = new Set(readJson(digestFile).paperIds);
  const receiptPaperIds = new Set();
  for (const [index, artifact] of receipt.canonicalPapers.entries()) {
    requireText(artifact.paperId, `${context}.canonicalPapers[${index}].paperId`);
    requireText(artifact.file, `${context}.canonicalPapers[${index}].file`);
    requireSha256(artifact.sha256, `${context}.canonicalPapers[${index}].sha256`);
    if (receiptPaperIds.has(artifact.paperId)) {
      fail(`${context}.canonicalPapers contains duplicate '${artifact.paperId}'.`);
    }
    receiptPaperIds.add(artifact.paperId);
    const paperFile = paperFilesById.get(artifact.paperId);
    if (!paperFile || !digestPaperIds.has(artifact.paperId)) {
      fail(`${context}.canonicalPapers contains a paper outside its digest.`);
    }
    if (artifact.file !== path.relative(root, paperFile)) {
      fail(`${context}.canonicalPapers '${artifact.paperId}' has the wrong file path.`);
    }
    // Canonical records may evolve after a later paper version; the receipt keeps the historical
    // hash for Git-level audit instead of requiring it to match the newest record forever.
  }
  if (
    receiptPaperIds.size !== digestPaperIds.size ||
    [...digestPaperIds].some((paperId) => !receiptPaperIds.has(paperId))
  ) {
    fail(`${context}.canonicalPapers must exactly cover its digest.`);
  }
  requireObject(receipt.publication, `${context}.publication`);
  requireBoolean(receipt.publication.handledSeparately, `${context}.publication.handledSeparately`);
  requireBoolean(
    receipt.publication.recordedAsPublished,
    `${context}.publication.recordedAsPublished`,
  );
}

console.log(
  `[paper-reading] valid: ${topics.length} UI topics, ${researchConfig.directions.length} ${researchConfig.status} research directions, ${venueRegistry.venues.length} venues, ${paperEntries.length} papers, ${digestEntries.length} digests, ${runReceiptEntries.length} run receipts`,
);
