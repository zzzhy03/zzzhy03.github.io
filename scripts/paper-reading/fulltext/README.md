# Full-text review contract

This stage follows abstract screening and still stops before canonical paper or digest writes.
Each review is grounded in one immutable PDF version, text extracted with `pdftotext -layout`,
and visual inspection of the relevant method, result, and limitation pages.

The local review file uses this shape:

```json
{
  "schemaVersion": 2,
  "kind": "paper-reading-fulltext-review",
  "runId": "paper-reading-2026-08-06",
  "candidateId": "candidate:stable-discovery-id",
  "paperId": "arxiv:2608.00000",
  "arxivVersion": "2608.00000v1",
  "title": "Paper title",
  "reviewedAt": "2026-08-06T13:00:00.000Z",
  "reviewer": {
    "kind": "ai",
    "name": "Codex full-text review",
    "model": "GPT-5"
  },
  "source": {
    "scope": "full_text",
    "pdfPath": "local-assets/paper-reading/runs/paper-reading-2026-08-06/fulltext/sources/2608.00000v1.pdf",
    "pdfSha256": "lowercase sha256",
    "pageCount": 12,
    "textExtraction": "pdftotext-layout",
    "visuallyInspectedPages": [1, 3, 6, 10]
  },
  "decision": "accept-deep",
  "primaryTopicId": "2d-design",
  "secondaryTopicIds": [],
  "relevance": "high",
  "readingAction": "deep",
  "confidence": "high",
  "thirtySecondZh": "One dense descriptive conclusion.",
  "descriptiveSummaryZh": "What problem is solved, how, and what was actually demonstrated.",
  "methodFlow": ["Input", "Representation", "Core operation", "Output"],
  "noveltyAssessmentZh": "What is genuinely new relative to the paper's stated baselines.",
  "evidence": [
    {
      "claimZh": "A bounded claim.",
      "locator": "Sec. 3.2, Fig. 2, p. 5",
      "support": "paper-method",
      "noteZh": "Why this location supports the claim."
    }
  ],
  "experiments": {
    "setupZh": "Datasets, models, and evaluation setting.",
    "keyResults": [
      { "resultZh": "Author-reported numerical or qualitative result.", "locator": "Table 1, p. 7" }
    ],
    "baselineCoverageZh": "What was compared and what important comparison is absent.",
    "ablationZh": "What the ablations establish and fail to establish."
  },
  "limitations": {
    "authorsZh": [],
    "reviewerRisksZh": ["Evidence-bounded reviewer concern."]
  },
  "code": { "status": "not-found", "url": null },
  "visuals": {
    "methodFigure": { "page": 5, "label": "Fig. 2", "reasonZh": "Why it explains the method." },
    "conceptFigure": null
  },
  "whyRelevantZh": "Connection to the tracked research direction.",
  "decisionRationaleZh": "Why this belongs in the first digest, only the library, or neither."
}
```

Allowed decisions are `accept-deep`, `accept-skim`, `defer`, and `reject`. `defer` means a
future version, code release, or stronger evidence is needed; it is not canonical acceptance.
Evidence support is `paper-method`, `paper-experiment`, or `reviewer-inference`. Accept decisions
need at least three evidence items, one located result, and visual inspection of the first page,
the main method figure, the main result table, and any explicit limitations page. Numerical
claims remain author-reported unless independently reproduced. Code is `available`, `promised`,
or `not-found`; `available` requires a URL printed in the PDF.

The daily default is to review every screening decision marked `full-text-review`. If an explicit
priority split is needed, validate the selected subset and then record every remaining candidate
in `<run-dir>/fulltext/backlog.json`; an absent paper may never be treated as an implicit reject.

Validate an entire local review set, including the immutable PDF hashes and the exact high-
relevance/deep-reading handoff from the preceding screening run:

```sh
npm run validate:paper-fulltext -- \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --selection all-full-text
```

After validation, produce a local editorial summary without touching canonical paper records or
digests:

```sh
npm run summarize:paper-fulltext -- \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --selection all-full-text
```

The generated `<run-dir>/fulltext/summary.json` remains ignored by Git and intentionally makes no
claim about promotion, publication, or discovery-state advancement. Those are separate gates.

When a reviewed set is promoted, validate the editorial boundary as well as the public content
schema:

```sh
npm run validate:paper-promotion -- \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --digest content/paper-reading/digests/YYYY-MM-DD.json
```

This joins each accepted review to its versionless canonical ID, verifies the exact reviewed
arXiv version and code status, preserves the final relevance/reading decision, and requires the
launch digest to contain exactly the promoted review set.
