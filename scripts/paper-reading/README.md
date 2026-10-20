# Paper Reading discovery and editorial contracts

The operational source of truth is [PIPELINE.md](./PIPELINE.md). This file documents the
discovery, screening, and full-text contracts used inside that end-to-end runbook.

This directory contains the provider-facing discovery layer. It stops before editorial
screening: it does not call a model, accept papers, write canonical records or digests, run a
site build, commit, push, or publish.

## Window and state

Checked-in state has two separate responsibilities:

- `content/paper-reading/state/discovery-state.json` stores the successful discovery watermark;
- `content/paper-reading/state/decision-ledger.json` stores receipt-backed decision observations
  used to avoid repeating an identical review.

The initial `lastSuccessfulRunAt` is deliberately `null`; it does not pretend that discovery has
already run. Bootstrap with an explicit timestamp:

```sh
npm run discover:papers -- --since 2026-08-06T00:00:00+08:00
```

After a successful watermark exists, the default start is:

```text
lastSuccessfulRunAt - overlapHours
```

The default overlap is 48 hours. The arXiv adapter includes a record when either `publishedAt`
or `updatedAt` is inside the inclusive window, so an older paper with a new version is retained.
No artificial reports are created for dates when the machine did not run; the next run simply
catches up from the last successful watermark.

`--record-success` remains a low-level compatibility flag. The standard daily workflow does not
use it: after screening, full-text closure, promotion, canonical validation and receipt creation,
`pipeline finalize` advances the watermark from the immutable manifest. Fixture, partial, failed,
truncated, and `--no-write` discovery runs can never qualify.

## Outputs

The default output is under the already ignored local directory:

```text
local-assets/paper-reading/runs/<run-id>/
  candidates.json
  manifest.json
```

`candidates.json` contains normalized, source-preserving retrieval candidates. A candidate's
`retrievalTopicIds` only says which query surfaced it; it is not a relevance judgement.
`locallyMatchedTopicIds` is the stricter provider-neutral substring check against the configured
query families. A topic present only in `retrievalTopicIds` may be an arXiv stemming or
tokenization match. It remains staged for recall, but screening should treat it as weaker
retrieval evidence rather than a confirmed topic match.
`disposition` is one of:

- `new`
- `possible-update`
- `duplicate-existing`
- `manual-review` (identity keys conflict across canonical records)

`manifest.json` records the exact window, state snapshot, selected topics and sources, per-source
query/request/status information, rate-limit policy, record counts, output paths, and explicit
limitations. Both files say that model screening and summary generation have not run.

## Sources

The arXiv adapter is implemented against its Atom API. It combines all query families for one
research direction into one provider query, sorts by `lastUpdatedDate`, paginates until it crosses
the window boundary, and filters `publishedAt OR updatedAt` locally. Requests use a single serial
connection with an enforced delay of at least 3100 ms across every topic, page, and retry attempt.
HTTP 429, 5xx responses, and an explicit allowlist of transient network failures receive at most
three attempts; ordinary 4xx responses fail immediately. Per-attempt outcomes and retry counts are
kept in the manifest. Reaching the per-topic safety cap or exhausting a retry before crossing the
window makes the source `partial`, which prevents a state advance.

Discovery always writes the complete candidate set for the window. It does not consult the
decision ledger to suppress provider results; exact decision reuse happens only when screening
inputs are prepared, so every overlap-window candidate remains auditable.

OpenReview, official venue proceedings, and official technical reports have separate adapter
interfaces but are `not-configured`. Their status is visible in every default manifest instead of
silently appearing as an empty search. Future implementations must preserve provider provenance:
OpenReview should use forum IDs; venue sources should be provider-specific and registry-driven;
official reports require a reviewed first-party feed allowlist.

## Identity and deduplication

Candidate and canonical records are matched in this order:

1. normalized lowercase DOI;
2. versionless arXiv ID;
3. OpenReview forum ID;
4. normalized title + first author + year.

The discovery layer never changes a canonical paper ID. A newer arXiv version, newly discovered
DOI, or journal reference is staged as a possible update to the existing record.

Canonical deduplication and decision reuse are related but different. The reusable decision key is
an exact version such as `arxiv:2608.05131@v2`, not the versionless paper ID and not `candidateId`.
Reuse additionally requires an identical candidate-evidence fingerprint and the same active policy
fingerprint. A new version, changed abstract/metadata/source evidence, or changed policy therefore
returns to screening even when the canonical paper ID is unchanged.

## Useful commands

Run the offline fixture suite:

```sh
npm run test:paper-discovery
```

Inspect a deterministic offline staging run:

```sh
npm run discover:papers -- \
  --since 2026-08-04T00:00:00Z \
  --now 2026-08-06T00:00:00Z \
  --source arxiv \
  --topic lego,embroidery,2d-design \
  --fixture-arxiv scripts/paper-reading/fixtures/arxiv-window.atom.xml \
  --run-id fixture-preview
```

Restrict a later live dry run to one direction while debugging:

```sh
npm run discover:papers -- \
  --since 2026-08-06T00:00:00+08:00 \
  --source arxiv \
  --topic embroidery
```

Use `npm run discover:papers -- --help` for all safety caps and path overrides.

## Screening handoff (still local staging)

Discovery can now be followed by a separate AI-or-human screening contract. Preparing the
handoff reads only the discovery run's `candidates.json` and `manifest.json`, plus the reviewed
research and venue configuration and the checked-in decision ledger:

```sh
npm run prepare:paper-screening -- \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --batch-size 12
```

The batch size is operational only. Every discovery candidate is accounted for exactly once, but
only ledger misses are included in reviewer batches. By default the new files stay inside the same
ignored local run directory:

```text
<run-dir>/screening/
  screening-manifest.json
  decision-ledger-input.json   # immutable match/miss snapshot
  batches/
    batch-001.input.json
  reviews/
    batch-001.review.json  # supplied later by an AI or human reviewer
```

Preparation computes a candidate-evidence fingerprint and an active policy fingerprint from the
research config, venue registry, selected topics, screening contract, and full-text schema. A
previous observation is reusable only when exact arXiv version, evidence fingerprint, and policy
fingerprint all match, the prior outcome is terminal, and any required canonical exact version
still exists. The referenced immutable delta and receipt must also still exist locally and pass
their recorded hashes; missing proof fails safely by returning the candidate to screening. Both
matches and misses are frozen in `decision-ledger-input.json`, whose hash is recorded by the
screening manifest. A `draft` research config or venue registry never enables reuse.
Resolution always considers the complete matching history first: a later non-terminal decision,
or a terminal decision whose provenance no longer verifies, can never expose an older terminal
decision as a fallback.

To deliberately revisit every candidate in a new run without editing the ledger, pass
`--ignore-decision-ledger` when preparing screening. The override is recorded in the snapshot and
manifest; `--force` alone only regenerates files and does not bypass prior decisions.

Preparation does not call a model and does not create new reviewer decisions. Each batch carries
the attention-policy gates, routing rules, negative signals, controlled facet taxonomy, and venue
policy needed for a reviewer to make a decision. In particular:

- `retrievalTopicIds` are retrieval provenance, not final classification or relevance;
- the reviewer selects primary and secondary topics from the paper's actual contribution and may
  cross-route to a topic that did not retrieve the paper;
- the final primary topic's `attentionPolicy` gate must be evaluated explicitly, while venue is a
  signal rather than an automatic acceptance rule;
- negative signals apply only when they describe the paper's actual object or contribution, not
  merely related work;
- facet hints, relevance, and reading action remain preliminary at this stage.

### Reviewer output

One review JSON is expected for each prepared batch. Its `decisions` array must contain exactly
one entry for every candidate in that batch; ledger matches have no new review file and remain
accounted for by the immutable input snapshot. The complete enums and required fields live in each
batch's `reviewContract`; the core shape is:

```json
{
  "schemaVersion": 1,
  "kind": "paper-reading-screening-review",
  "runId": "<run-id>",
  "batchId": "batch-001",
  "reviewer": { "kind": "ai", "name": "review pass", "model": "<model>" },
  "reviewedAt": "2026-08-06T01:00:00.000Z",
  "decisions": [
    {
      "candidateId": "candidate:<id>",
      "decision": "full-text-review",
      "primaryTopicId": "2d-design",
      "secondaryTopicIds": [],
      "topicMatch": "direct",
      "significance": "unknown",
      "reasonCodes": [
        "direct-topic-fit",
        "significance-unclear",
        "attention-gate-uncertain",
        "needs-full-text"
      ],
      "rationaleZh": "任务直接相关，但 abstract 不足以判断方法推进幅度。",
      "negativeSignalAssessment": {
        "status": "none",
        "matchedSignals": [],
        "rationaleZh": "未发现适用的负面信号。"
      },
      "attentionGate": {
        "policyId": "continuous",
        "outcome": "uncertain",
        "rationaleZh": "需要全文确认是否达到 continuous gate。"
      },
      "suggestedSourceScope": "full_text",
      "preliminary": { "relevance": "medium", "readingAction": "skim" },
      "facetHints": { "task": ["generation"] },
      "evidenceBoundary": {
        "screeningBasis": "abstract",
        "basisSufficientForDecision": false,
        "downstreamClaimScope": "full-text-required"
      }
    }
  ]
}
```

Allowed decisions are `reject`, `full-text-review`, `accept-from-abstract`, and
`manual-review`. `accept-from-abstract` is deliberately narrow: the abstract must reliably
establish the decision, `suggestedSourceScope` must be `abstract`, and downstream claims must stay
`abstract-only`. A later summary must never describe this as full-text evidence.

Validate a complete review set with:

```sh
npm run validate:paper-screening -- \
  --run-dir local-assets/paper-reading/runs/<run-id>
```

The validator is read-only. It checks the ledger snapshot hash and ownership, prepared-input hashes,
batch ownership, topic and facet IDs, attention-policy consistency, decision-specific evidence
boundaries, and that every discovery candidate is accounted for by exactly one snapshot match or
one new decision. Passing validation still does not accept papers, write canonical records or
digests, build the site, or publish anything.

Run its offline contract fixtures with:

```sh
npm run test:paper-screening
```

## Full-text review handoff

Candidates marked `full-text-review` can be reviewed against an immutable, versioned PDF. The
review contract stores the PDF SHA-256, exact pages visually inspected, bounded evidence with
locators, author limitations separately from reviewer risks, and the final `accept-deep`,
`accept-skim`, `defer`, or `reject` decision. See `fulltext/README.md` for the complete shape.

The validator can join the review set back to either all screening-stage full-text candidates or
only the high-relevance/deep-reading slice. It verifies exact completeness as well as each local
PDF hash and page count:

```sh
npm run validate:paper-fulltext -- \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --selection all-full-text
```

`all-full-text` is the normal daily policy. A narrower selection such as `high-deep` is allowed
only when the remaining candidates are written to the explicit run-scoped backlog. The pipeline
controller enforces that closure. A run with zero selected full-text candidates, or an
`all-full-text` run with every selected candidate reviewed, closes with an inline empty backlog in
its receipt and does not create a placeholder `backlog.json`. The controller derives a zero count
from validated screening; standalone full-text, summary, and promotion commands require an explicit
`--expected-count 0` after screening validation. `npm run summarize:paper-fulltext -- --run-dir <run>` writes a
local editorial summary after the same checks pass; it does not infer promotion or publication.

`screening-reject`, `accepted-deep`, `accepted-skim`, `fulltext-reject`, and a canonical-backed
`administrative-already-canonical` observation are terminal for an identical exact-version,
evidence, and active-policy tuple. `administrative-backlog`, `manual-review`, `defer`, and an
abstract acceptance still awaiting promotion are non-terminal and are not automatically skipped
on the next run.

## Receipt, decision ledger, and finalization

After promotion and all read-only gates pass, the normal command order is:

```sh
# Inspect, then write the receipt and its immutable run-scoped decision delta.
npm run pipeline:papers -- receipt \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --selection all-full-text \
  --digest content/paper-reading/digests/YYYY-MM-DD.json
npm run pipeline:papers -- receipt \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --selection all-full-text \
  --digest content/paper-reading/digests/YYYY-MM-DD.json \
  --apply

# Inspect, then import only that receipt-verified immutable delta.
npm run pipeline:papers -- ledger \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --selection all-full-text \
  --digest content/paper-reading/digests/YYYY-MM-DD.json
npm run pipeline:papers -- ledger \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --selection all-full-text \
  --digest content/paper-reading/digests/YYYY-MM-DD.json \
  --apply

# Finalize re-verifies/imports the ledger idempotently before advancing the watermark.
npm run pipeline:papers -- finalize \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --selection all-full-text \
  --digest content/paper-reading/digests/YYYY-MM-DD.json
npm run pipeline:papers -- finalize \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --selection all-full-text \
  --digest content/paper-reading/digests/YYYY-MM-DD.json \
  --apply
```

`receipt --apply` creates `<run-dir>/decision-ledger/delta.json` and pins its SHA-256 in the
checked-in receipt. `ledger` imports that immutable delta idempotently. `finalize` always performs
the verified ledger merge first and writes `discovery-state.json` only after it succeeds; running
the explicit `ledger` step beforehand is useful for inspecting the decision counts but is not a
correctness dependency.

### One-time legacy backfill

The verified 2026-08-06 `high-deep` and 2026-08-07 `all-full-text` runs can be imported without
re-running discovery or review. Run them oldest first, inspecting each dry-run before `--apply`:

```sh
npm run pipeline:papers -- ledger \
  --run-dir local-assets/paper-reading/runs/live-dry-run-20260806-v2 \
  --selection high-deep \
  --digest content/paper-reading/digests/2026-08-06.json
npm run pipeline:papers -- ledger \
  --run-dir local-assets/paper-reading/runs/live-dry-run-20260806-v2 \
  --selection high-deep \
  --digest content/paper-reading/digests/2026-08-06.json \
  --apply

npm run pipeline:papers -- ledger \
  --run-dir local-assets/paper-reading/runs/paper-reading-20260807-094202 \
  --selection all-full-text \
  --digest content/paper-reading/digests/2026-08-07.json
npm run pipeline:papers -- ledger \
  --run-dir local-assets/paper-reading/runs/paper-reading-20260807-094202 \
  --selection all-full-text \
  --digest content/paper-reading/digests/2026-08-07.json \
  --apply
```

This is a compatibility path for receipts created before delta pinning. It derives each immutable
delta only from the legacy receipt's still-verified run artifacts and records the receipt/delta
hashes in the aggregate ledger. Do not finalize the older run or move the watermark backwards.
New runs must use `receipt --apply` before ledger import.

## Deliberately deferred

- automatically executing the AI/human screening and full-text reviewer (the contracts and
  validators consume reviewer-supplied output);
- automated PDF acquisition, retry/version policy, and image-generation execution;
- automatically generating and applying a canonical promotion plan (the current promotion gate
  validates reviewer-supplied canonical records and the digest);
- OpenReview, proceedings, and official-report network implementations;
- semantic/fuzzy duplicate review beyond exact normalized identity keys;
- partitioning, compaction, and an indexed lookup for the aggregate decision ledger (the current
  trial version keeps one checked-in JSON file and scans matching observations in memory);
- Zotero, user-state sync, and publishing.
