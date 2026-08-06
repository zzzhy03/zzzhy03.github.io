# Paper Reading content

This directory is the source of truth for the standalone `/paper_reading/daily/` feed
and `/paper_reading/library/` collection.
It is intentionally independent from project-specific literature reports.

## Layout

- `topics.json` defines the research directions shown by the first-level switcher.
- `research-config.json` is the active, versioned discovery and classification policy for
  daily automation and canonical editorial records.
- `venue-registry.json` normalizes venue names and assigns scan policies. Venue is a
  ranking signal, never a hard inclusion gate.
- `RESEARCH-SCOPE.md` is the review-friendly summary of the active scope and its maintenance
  checklist.
- `papers/*.json` stores one canonical record per paper.
- `digests/*.json` stores dated update events and references papers by stable ID.

Each canonical paper may carry structured discovery metadata in addition to the reading
summary:

- `identifiers`: bare, versionless identifiers (`doi`, `arxiv`, `openReviewForum`);
- `venueIds`: normalized IDs from `venue-registry.json` (empty for unmatched preprints);
- `publicationType`: `peer-reviewed`, `preprint`, or `technical-report`;
- `collectedAt`: immutable date when the paper first entered the canonical library;
- `primaryTopicId`: the main member of `topicIds` used for grouping;
- `facets`: controlled value IDs grouped by dimensions from `tagTaxonomy`.

The discovery metadata remains optional during migration, but `collectedAt` is required so
historical backfill cannot rewrite collection history. `npm run prepare:papers` supplies conservative
library defaults for older records: the first topic becomes primary, identifiers are inferred
from stable IDs and canonical links when possible, facets and venue IDs become empty collections, and
publication type is inferred from normalized venue metadata.

The research configuration contains twelve active directions, provider-neutral query
families, contextual negative signals, attention policies, typed facets, cross-topic routing,
global exclusions, deduplication rules, and the planned cross-date library fields. The venue
registry is kept separate so venue aliases and publication families can evolve without
mixing source normalization into the research taxonomy.

`topics.json` exposes the twelve enabled directions in the order recorded by
`research-config.json.ui.directionOrder`. Every digest contains a brief for every direction;
an empty `paperIds` list is valid and explicitly means that nothing qualified in that issue.

Daily automation should normalize identifiers in this order: DOI, versionless arXiv ID,
OpenReview forum ID, then normalized title plus first author and year. A digest may reference
an existing paper again when its venue, code, version, or other meaningful metadata changes;
it should not duplicate the complete paper record.

An existing paper ID is permanent. When a preprint later receives a DOI or a formal venue,
the automation adds identifiers and publication metadata to the same record rather than
re-keying it; this preserves browser or future cloud user state keyed by paper ID.

## Generated static feed

`npm run prepare:papers` rebuilds `public/paper-reading/data/` from the canonical content:

- `digests/YYYY-MM-DD.json` contains the existing bounded daily bundle;
- `papers/<slug>.json` contains one lazily loadable canonical paper;
- `index.json` lists available report dates;
- `paper-index.json` is a deduplicated cross-date array for search and filtering;
- `library-meta.json` contains only public labels for topics, venues, facets, and enum options.

Every library entry includes immutable `collectedAt`, plus `firstReportedDate`,
`lastReportedDate`, and ascending `digestDates` derived from digest references. Backfilled
digest dates therefore do not change when a paper was actually collected. The entry also includes normalized identifiers,
topics, facets, venue IDs, keywords, categories, direct `paperHref`, optional `codeHref`, and
`hasCode`. A canonical paper that has not appeared in a digest remains discoverable in the
library by its collection date, with null first/last report dates and an empty digest date list.

The library metadata intentionally excludes discovery queries, negative signals, routing
rules, scan policies, source admission rules, and other automation strategy. The generated
paper index remains a top-level JSON array so the existing reading-list client continues to
load it without an envelope migration.

Search query families are provider-neutral. Each family is compiled as an exact phrase match,
or as one anchor term combined with one technical action term. Negative signals are evaluated
against the paper's primary subject and contribution; their mere appearance in related work or
references is not sufficient for rejection.

The 2026-08-05 digest is retained as the migrated interface trial. The 2026-08-06 digest is the
first issue produced from the active twelve-direction scope and records its source and full-text
coverage explicitly. Historical backfill should use `mode: "backfill"` and remain separate from
daily discovery.

## Personal state

Relevance overrides, reading actions, stars, read-later flags, read state, and Zotero archive
requests are user state, not paper metadata. The current static page stores them in browser
storage. A
future cloud adapter should key state by canonical paper ID and authenticated owner ID.
Zotero credentials must never be shipped to the static page; a local automation can consume
authenticated archive requests and write the paper plus its reading summary to Zotero.

The quick-read fields are source-aware editorial analysis rather than claims that every paper
must contain. `whyRelevantZh` is a model/editor judgement against the tracked research topics;
`evidenceZh` and `caveatZh` must only be populated when the checked source supports them. These
fields are optional and the interface hides absent sections. Future daily automation should add
claim-level section/table/figure references when they can be verified, rather than inventing a
locator.
