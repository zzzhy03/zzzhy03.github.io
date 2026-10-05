import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateFulltextReviews } from "../../fulltext/validate.mjs";
import { validatePromotion } from "../../fulltext/validate-promotion.mjs";
import { buildCanonicalIndex, matchCanonicalCandidates } from "../../lib/dedupe.mjs";
import { isPaperWithdrawn, publicDigest, withdrawalRecord } from "../../lib/withdrawal.mjs";
import { prepareScreening } from "../../screening/prepare.mjs";
import { receiptStatus, runFinalize, runReceipt, runWithdraw } from "../../pipeline.mjs";
import { verifyDecisionLedgerImports } from "../../decision-ledger.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const roots = [];
const paperId = "arxiv:2608.30209";
const version = "2608.30209v2";
const noticeHtml = `<html><head><title>[${version}] DICS</title></head><body><span class="error">This paper has been withdrawn by Author</span></body></html>`;

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "paper-withdrawal-"));
  roots.push(root);
  const run = path.join(root, "local-assets/paper-reading/runs/run-001");
  const reviewDirectory = path.join(run, "fulltext/reviews");
  const source = path.join(run, `fulltext/sources/${version}.withdrawal.html`);
  mkdirSync(path.dirname(source), { recursive: true });
  writeFileSync(source, noticeHtml);
  mkdirSync(path.join(root, "content/paper-reading"), { recursive: true });
  copyFileSync(path.join(repositoryRoot, "content/paper-reading/research-config.json"), path.join(root, "content/paper-reading/research-config.json"));
  const review = {
    schemaVersion: 3, kind: "paper-reading-fulltext-review", runId: "run-001",
    candidateId: "candidate:withdrawal", paperId, arxivVersion: version, title: "DICS",
    reviewedAt: "2026-10-05T04:00:00Z", reviewer: { kind: "ai", name: "Codex", model: "GPT-6" },
    source: { scope: "withdrawal_notice", noticePath: path.relative(root, source),
      noticeSha256: createHash("sha256").update(noticeHtml).digest("hex"),
      noticeUrl: `https://arxiv.org/abs/${version}`, retrievedAt: "2026-10-05T04:00:00Z" },
    decision: "reject", relevance: "low", readingAction: "skip", confidence: "high",
    primaryTopicId: "vlm-mllm", secondaryTopicIds: [],
    thirtySecondZh: "该版本已由作者撤稿。", descriptiveSummaryZh: "官方页面记录撤稿。",
    noveltyAssessmentZh: "没有可收录的版本事件。", whyRelevantZh: "原收录论文撤稿。",
    decisionRationaleZh: "撤稿，移除前版公开收录。", methodFlow: [], evidence: [],
    experiments: { keyResults: [] }, visuals: { methodFigure: null, conceptFigure: null },
    code: { status: "not-found", url: null },
  };
  const reviewFile = path.join(reviewDirectory, `${version}.json`);
  writeJson(reviewFile, review);
  return { root, run, review, reviewFile, reviewDirectory, source };
}

function validate(f) {
  return validateFulltextReviews({ root: f.root, reviewDirectory: f.reviewDirectory,
    researchConfig: "content/paper-reading/research-config.json", expectedCount: 1 });
}

test.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

test("an exact official withdrawal notice closes a reject without a PDF", () => {
  const f = fixture();
  const result = validate(f);
  assert.deepEqual(result.errors, []);
  assert.equal(result.counts.byDecision.reject, 1);
  assert.equal(existsSync(path.join(f.run, `fulltext/sources/${version}.pdf`)), false);
});

test("notice acceptance, nonofficial URLs, tampered bytes, and symlinks are refused", () => {
  const f = fixture();
  for (const mutate of [
    (review) => { review.decision = "accept-skim"; review.readingAction = "skim"; },
    (review) => { review.source.noticeUrl = `https://example.com/abs/${version}`; },
    (review) => { review.source.noticeSha256 = "0".repeat(64); },
    (review) => { review.source.noticePath = "../outside.html"; },
    (review) => { review.source.visuallyInspectedPages = [1]; },
    (review) => { review.experiments.keyResults = [{ resultZh: "unread result", locator: "p.1" }]; },
  ]) {
    const review = structuredClone(f.review);
    mutate(review);
    writeJson(f.reviewFile, review);
    assert.notEqual(validate(f).errors.length, 0);
  }
  writeJson(f.reviewFile, f.review);
  const outside = path.join(f.root, "outside.html");
  writeFileSync(outside, noticeHtml);
  const link = path.join(path.dirname(f.source), "linked.html");
  symlinkSync(outside, link);
  writeJson(f.reviewFile, { ...f.review, source: { ...f.review.source, noticePath: path.relative(f.root, link) } });
  assert.match(validate(f).errors.join(" "), /inside this run/);
});

test("a newer-version withdrawal banner, wrong exact version, or mere 404 is insufficient", () => {
  const f = fixture();
  for (const html of [
    noticeHtml.replace("This paper has been withdrawn by", "A newer version of this paper has been withdrawn by"),
    noticeHtml.replace(`[${version}]`, "[2608.30209v1]"),
    "<html><title>404 Not Found</title></html>",
  ]) {
    writeFileSync(f.source, html);
    writeJson(f.reviewFile, { ...f.review, source: { ...f.review.source,
      noticeSha256: createHash("sha256").update(html).digest("hex") } });
    assert.notEqual(validate(f).errors.length, 0);
  }
});

test("ordinary rejection still requires an exact PDF and screening version must match", () => {
  const f = fixture();
  writeJson(f.reviewFile, { ...f.review, source: { scope: "full_text", textExtraction: "pdftotext-layout",
    pdfPath: "missing.pdf", pdfSha256: "0".repeat(64), pageCount: 1, visuallyInspectedPages: [1] } });
  assert.match(validate(f).errors.join(" "), /PDF does not exist/);
  writeJson(f.reviewFile, f.review);
  writeJson(path.join(f.run, "candidates.json"), { runId: "run-001", candidates: [{
    discoveryId: f.review.candidateId, identifiers: { arxiv: ["2608.30209"] }, arxivVersion: 3,
  }] });
  writeJson(path.join(f.run, "screening/reviews/batch-001.review.json"), {
    decisions: [{ candidateId: f.review.candidateId, decision: "full-text-review" }],
  });
  const result = validateFulltextReviews({ root: f.root, reviewDirectory: f.reviewDirectory,
    researchConfig: "content/paper-reading/research-config.json",
    screeningRunDirectory: f.run, selection: "all-full-text" });
  assert.match(result.errors.join(" "), /screening exact version/);
});

test("v3 is a fresh candidate with stable paper identity and cannot resurrect historical v1", () => {
  const f = fixture();
  const paper = { id: paperId, links: [{ label: "Paper", href: "https://arxiv.org/abs/2608.30209v1" }],
    withdrawal: withdrawalRecord(f.review) };
  assert.equal(isPaperWithdrawn(paper), true);
  const later = { ...paper, links: [{ label: "Paper", href: "https://arxiv.org/abs/2608.30209v3" }] };
  assert.equal(isPaperWithdrawn(later), false);
  assert.equal(isPaperWithdrawn({ ...paper, links: [{ label: "Paper", href: "https://arxiv.org/abs/2608.30209" }] }), true);
  const candidate = { arxivVersion: 3, identity: { keys: [{ key: paperId, type: "arxiv" }] },
    identifiers: { doi: [], arxiv: ["2608.30209"] }, sourceNotes: {} };
  const [matched] = matchCanonicalCandidates([candidate], buildCanonicalIndex([paper]));
  assert.equal(matched.disposition, "new");
  assert.equal(matched.existingMatch.paperId, paperId);
  assert.equal(matched.existingMatch.resubmission, true);
  const digest = { paperIds: [paperId], overview: { bulletsZh: [] }, topicBriefs: [{ paperIds: [paperId] }] };
  const visible = new Set([paperId]);
  const withdrawn = new Map([[paperId, 2]]);
  assert.deepEqual(publicDigest(digest, visible, withdrawn, new Map([[paperId, "2608.30209v1"]])).paperIds, []);
  assert.deepEqual(publicDigest(digest, visible, withdrawn, new Map([[paperId, "2608.30209v3"]])).paperIds, [paperId]);
  assert.deepEqual(digest.paperIds, [paperId]); // The receipt-pinned source digest is unchanged.
});

test("a v3 withdrawal removes v1, v2 and v3; only a freshly reviewed v4 can return", () => {
  const paper = { id: paperId,
    links: [{ label: "Paper", href: "https://arxiv.org/abs/2608.30209v2" }],
    withdrawal: { arxivVersion: "2608.30209v3" } };
  const digest = { paperIds: [paperId], overview: { bulletsZh: [] },
    topicBriefs: [{ paperIds: [paperId] }] };
  const withdrawn = new Map([[paperId, 3]]);
  for (const oldVersion of [1, 2, 3]) {
    const exactVersion = `2608.30209v${oldVersion}`;
    assert.equal(isPaperWithdrawn({ ...paper,
      links: [{ label: "Paper", href: `https://arxiv.org/abs/${exactVersion}` }] }), true);
    const historical = publicDigest(digest, new Set([paperId]), withdrawn,
      new Map([[paperId, exactVersion]]));
    assert.deepEqual(historical.paperIds, []);
    assert.deepEqual(historical.topicBriefs[0].paperIds, []);
    const [candidate] = matchCanonicalCandidates([{
      arxivVersion: oldVersion, identity: { keys: [{ key: paperId, type: "arxiv" }] },
      identifiers: { doi: [], arxiv: ["2608.30209"] }, sourceNotes: {},
    }], buildCanonicalIndex([paper]));
    assert.equal(candidate.existingMatch.resubmission, false);
  }
  const [v4] = matchCanonicalCandidates([{
    arxivVersion: 4, identity: { keys: [{ key: paperId, type: "arxiv" }] },
    identifiers: { doi: [], arxiv: ["2608.30209"] }, sourceNotes: {},
  }], buildCanonicalIndex([paper]));
  assert.equal(v4.disposition, "new");
  assert.equal(v4.existingMatch.resubmission, true);
  assert.deepEqual(publicDigest(digest, new Set([paperId]), withdrawn).paperIds, []);
  assert.deepEqual(publicDigest(digest, new Set([paperId]), withdrawn,
    new Map([[paperId, "2608.30209v4"]])).paperIds, [paperId]);
});

test("the generated site removes every public copy while retaining canonical audit content", () => {
  const f = fixture();
  const content = path.join(f.root, "content/paper-reading");
  for (const file of ["topics.json", "venue-registry.json"]) {
    copyFileSync(path.join(repositoryRoot, "content/paper-reading", file), path.join(content, file));
  }
  const slug = "dics-exploring-data-intrinsic-consistency-for-visual-instruction-selection";
  const paper = JSON.parse(readFileSync(path.join(repositoryRoot, `content/paper-reading/papers/${slug}.json`)));
  paper.withdrawal = withdrawalRecord(f.review);
  const paperFile = path.join(content, `papers/${slug}.json`);
  writeJson(paperFile, paper);
  const digest = JSON.parse(readFileSync(path.join(repositoryRoot, "content/paper-reading/digests/2026-09-02.json")));
  digest.paperIds = [paperId];
  digest.topicBriefs = digest.topicBriefs.map((brief) => ({ ...brief, paperIds: brief.topicId === "vlm-mllm" ? [paperId] : [] }));
  const digestFile = path.join(content, "digests/2026-09-02.json");
  writeJson(digestFile, digest);
  writeJson(path.join(content, "runs/2026-09-02.json"), { digestDate: digest.date,
    fulltext: { reviews: [{ paperId, arxivVersion: "2608.30209v1", decision: "accept-skim" }] } });
  const originalDigest = readFileSync(digestFile, "utf8");
  const build = () => execFileSync(process.execPath, [path.join(repositoryRoot, "scripts/build-paper-reading-feed.mjs")], { cwd: f.root });
  build();
  const output = path.join(f.root, "public/paper-reading/data");
  assert.deepEqual(JSON.parse(readFileSync(path.join(output, "paper-index.json"))), []);
  const bundle = JSON.parse(readFileSync(path.join(output, "digests/2026-09-02.json")));
  assert.deepEqual(bundle.digest.paperIds, []);
  assert.deepEqual(bundle.papers, []);
  assert.equal(existsSync(path.join(output, `papers/${slug}.json`)), false);
  assert.equal(existsSync(paperFile), true);
  assert.equal(readFileSync(digestFile, "utf8"), originalDigest);
  paper.links.find((link) => link.label === "Paper").href = "https://arxiv.org/abs/2608.30209v3";
  writeJson(paperFile, paper);
  build();
  assert.equal(JSON.parse(readFileSync(path.join(output, "paper-index.json"))).length, 0);
  writeJson(path.join(content, "runs/2026-10-05.json"), { digestDate: "2026-10-05",
    fulltext: { reviews: [{ paperId, arxivVersion: "2608.30209v3", decision: "accept-skim" }] } });
  build();
  assert.equal(JSON.parse(readFileSync(path.join(output, "paper-index.json"))).length, 1);
  assert.deepEqual(JSON.parse(readFileSync(path.join(output, "digests/2026-09-02.json"))).digest.paperIds, []);
});

test("v3 promotion must retain withdrawal history before it can reappear publicly", () => {
  const f = fixture();
  const slug = "dics-exploring-data-intrinsic-consistency-for-visual-instruction-selection";
  const paper = JSON.parse(readFileSync(path.join(repositoryRoot, `content/paper-reading/papers/${slug}.json`)));
  const priorWithdrawal = withdrawalRecord(f.review);
  delete paper.withdrawal;
  const laterVersion = "2608.30209v3";
  const laterReview = { ...f.review, arxivVersion: laterVersion, decision: "accept-skim",
    readingAction: "skim", source: { scope: "full_text" },
    code: { status: "available", url: "https://github.com/cqu-student/DICS" } };
  paper.links.find((link) => link.label === "Paper").href = `https://arxiv.org/abs/${laterVersion}`;
  paper.abstractSourceUrl = `https://arxiv.org/abs/${laterVersion}`;
  paper.analysis.sourceNote = `依据 exact version ${laterVersion} 全文整理。`;
  paper.analysis.relevance = laterReview.relevance;
  paper.analysis.readingAction = laterReview.readingAction;
  const paperFile = path.join(f.root, `content/paper-reading/papers/${slug}.json`);
  writeJson(paperFile, paper);
  const reviews = path.join(f.run, "promotion-fixture-reviews");
  writeJson(path.join(reviews, `${laterVersion}.json`), laterReview);
  writeJson(path.join(f.run, "candidates.json"), { candidates: [{
    discoveryId: f.review.candidateId, arxivVersion: 3, identifiers: { arxiv: ["2608.30209"] },
    disposition: "new", existingMatch: { paperId, resubmission: true, withdrawal: priorWithdrawal },
  }] });
  const digest = path.join(f.root, "content/paper-reading/digests/2026-10-05.json");
  writeJson(digest, { date: "2026-10-05", paperIds: [paperId] });
  const options = { root: f.root, runDirectory: f.run, reviewDirectory: reviews,
    paperDirectory: "content/paper-reading/papers", digest };
  assert.match(validatePromotion(options).errors.join(" "), /preserve its previous withdrawal/);
  writeJson(paperFile, { ...paper, withdrawal: priorWithdrawal });
  assert.deepEqual(validatePromotion(options).errors, []);
});

test("withdrawal apply, promotion, receipt, ledger and finalize preserve auditable terminal evidence", async () => {
  const f = fixture();
  const content = path.join(f.root, "content/paper-reading");
  for (const file of ["topics.json", "venue-registry.json"]) {
    copyFileSync(path.join(repositoryRoot, "content/paper-reading", file), path.join(content, file));
  }
  mkdirSync(path.join(content, "runs"));
  const slug = "dics-exploring-data-intrinsic-consistency-for-visual-instruction-selection";
  const paper = JSON.parse(readFileSync(path.join(repositoryRoot, `content/paper-reading/papers/${slug}.json`)));
  delete paper.withdrawal;
  const paperFile = path.join(content, `papers/${slug}.json`);
  writeJson(paperFile, paper);
  const candidate = { discoveryId: f.review.candidateId, title: paper.title, authors: paper.authors,
    abstract: paper.abstract, categories: paper.categories, primaryCategory: "cs.CV",
    publishedAt: "2026-08-31T03:44:54Z", updatedAt: "2026-09-01T08:33:59Z", arxivVersion: 2,
    identifiers: { arxiv: ["2608.30209"], doi: [], openReviewForum: [] },
    links: [{ label: "Paper", href: f.review.source.noticeUrl }], venueText: "arXiv preprint",
    sourceRecords: [{ source: "arxiv", sourceRecordId: version, url: f.review.source.noticeUrl }],
    sourceNotes: {}, retrievalTopicIds: ["vlm-mllm"], locallyMatchedTopicIds: ["vlm-mllm"],
    disposition: "possible-update", existingMatch: { paperId }, venueMatches: [], normalizationWarnings: [],
  };
  writeJson(path.join(f.run, "candidates.json"), { schemaVersion: 1, runId: "run-001", candidates: [candidate] });
  writeJson(path.join(f.run, "manifest.json"), { schemaVersion: 1, runId: "run-001",
    configuration: { selectedTopicIds: ["vlm-mllm"] },
    counts: { mergedCandidates: 1 }, sourceStatus: [{ id: "arxiv", status: "checked" }],
    window: { start: "2026-08-30T00:00:00Z", end: "2026-09-02T21:00:00Z", lastSuccessfulRunAt: "2026-09-01T21:00:00Z", overlapHours: 48 } });
  writeJson(path.join(content, "state/discovery-state.json"), { schemaVersion: 1,
    lastSuccessfulRunAt: "2026-09-01T21:00:00Z", lastRunId: "previous", overlapHours: 48 });
  await prepareScreening({ root: f.root, runDirectory: f.run });
  const screening = JSON.parse(readFileSync(path.join(repositoryRoot, "scripts/paper-reading/screening/fixtures/reviews/batch-001.review.json")));
  const decision = { ...screening.decisions[0], candidateId: f.review.candidateId,
    decision: "full-text-review", primaryTopicId: "vlm-mllm", suggestedSourceScope: "full_text",
    reasonCodes: ["direct-topic-fit", "meaningful-advance", "attention-gate-pass", "needs-full-text"], facetHints: {},
    evidenceBoundary: { screeningBasis: "abstract", basisSufficientForDecision: false, downstreamClaimScope: "full-text-required" } };
  writeJson(path.join(f.run, "screening/reviews/batch-001.review.json"), { ...screening, runId: "run-001", decisions: [decision] });
  const originalPaper = readFileSync(paperFile, "utf8");
  const planned = await runWithdraw({ selection: "all-full-text" }, f.root, f.run);
  assert.equal(planned.count, 1);
  assert.equal(readFileSync(paperFile, "utf8"), originalPaper);
  await runWithdraw({ selection: "all-full-text", apply: true }, f.root, f.run);
  assert.equal(isPaperWithdrawn(JSON.parse(readFileSync(paperFile))), true);
  assert.equal((await runWithdraw({ apply: true }, f.root, f.run)).count, 0);
  const digest = JSON.parse(readFileSync(path.join(repositoryRoot, "content/paper-reading/digests/2026-09-02.json")));
  digest.date = "2026-09-03";
  digest.paperIds = [];
  digest.topicBriefs = digest.topicBriefs.map((brief) => ({ ...brief, paperIds: [] }));
  const digestFile = path.join(content, "digests/2026-09-03.json");
  writeJson(digestFile, digest);
  mkdirSync(path.join(f.root, "scripts"), { recursive: true });
  copyFileSync(path.join(repositoryRoot, "scripts/validate-paper-reading.mjs"), path.join(f.root, "scripts/validate-paper-reading.mjs"));
  const options = { selection: "all-full-text", digest: digestFile, apply: true };
  await runReceipt(options, f.root, f.run);
  const receipt = JSON.parse(readFileSync(path.join(content, "runs/2026-09-03.json")));
  assert.equal(receipt.withdrawals[0].arxivVersion, version);
  assert.equal(receipt.withdrawals[0].notice.sha256, f.review.source.noticeSha256);
  assert.deepEqual(receipt.fulltext.backlog.candidateIds, []);
  await runFinalize(options, f.root, f.run);
  const ledger = JSON.parse(readFileSync(path.join(content, "state/decision-ledger.json")));
  assert.equal(ledger.observations[0].outcome, "fulltext-reject");
  assert.equal(ledger.observations[0].skipMode, "terminal");
  assert.equal(verifyDecisionLedgerImports({ ledger, root: f.root })[0].verified, true);
  writeFileSync(f.source, `${noticeHtml} changed`);
  assert.equal(receiptStatus(f.root, "run-001", digestFile, f.run).state, "invalid");
  assert.equal(verifyDecisionLedgerImports({ ledger, root: f.root })[0].verified, false);
});
