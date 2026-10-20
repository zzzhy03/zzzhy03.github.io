import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateFulltextReviews } from "../../fulltext/validate.mjs";
import { validatePromotion } from "../../fulltext/validate-promotion.mjs";
import { sourceVersionFor } from "../../lib/review-identity.mjs";
import { runFinalize } from "../../pipeline.mjs";

function writeJson(file, value) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value)); }
function pdf() {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >>",
    ...Array(4).fill("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>")];
  let data = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(data)); data += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(data);
  data += `xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Root 1 0 R /Size 7 >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(data);
}

test("conference full text validates official sources without an arXiv identifier and binds promotion", {
  skip: spawnSync("pdfinfo", ["-v"]).error ? "Poppler is required for full-text tests" : false,
}, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "conference-review-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = path.join(root, "local-assets/paper-reading/runs/conference-test");
  const paperUrl = "https://openreview.net/forum?id=abcDEF", pdfUrl = "https://openreview.net/pdf?id=abcDEF";
  const candidate = { discoveryId: "candidate:test", identity: { primaryKey: "openreview:abcDEF" }, title: "LEGO Generation", authors: ["Test Author"], abstract: "Original abstract", identifiers: { arxiv: [], openReviewForum: ["abcDEF"] },
    links: [{ label: "Paper", href: paperUrl }, { label: "PDF", href: pdfUrl }], disposition: "new",
    sourceRecords: [{ source: "openreview", sourceRecordId: "abcDEF", url: paperUrl, updatedAt: "2026-04-01" }] };
  const sourceVersion = sourceVersionFor(candidate), pdfPath = path.join(run, "fulltext/sources", `${sourceVersion}.pdf`), bytes = pdf();
  mkdirSync(path.dirname(pdfPath), { recursive: true }); writeFileSync(pdfPath, bytes);
  writeJson(path.join(root, "config.json"), { directions: [{ id: "lego" }] });
  writeJson(path.join(run, "candidates.json"), { runId: "conference-test", candidates: [candidate] });
  writeJson(path.join(run, "screening/reviews/batch-001.review.json"), { decisions: [{ candidateId: candidate.discoveryId, decision: "full-text-review" }] });
  const review = { schemaVersion: 4, kind: "paper-reading-fulltext-review", runId: "conference-test", candidateId: candidate.discoveryId,
    paperId: "openreview:abcDEF", sourceVersion, title: candidate.title, reviewedAt: "2026-10-16T00:00:00Z", reviewer: { kind: "human", name: "test" },
    source: { scope: "full_text", paperUrl, pdfUrl, pdfPath: path.relative(root, pdfPath), pdfSha256: createHash("sha256").update(bytes).digest("hex"), pageCount: 4, textExtraction: "pdftotext-layout", visuallyInspectedPages: [1, 2, 3, 4] },
    decision: "accept-skim", relevance: "high", readingAction: "skim", confidence: "high", primaryTopicId: "lego", secondaryTopicIds: [],
    thirtySecondZh: "test", descriptiveSummaryZh: "test", noveltyAssessmentZh: "test", whyRelevantZh: "test", decisionRationaleZh: "test",
    methodFlow: ["input", "output"], evidence: [1, 2, 3].map((n) => ({ claimZh: "test", locator: `p. ${n}`, noteZh: "test", support: "paper-method" })),
    experiments: { setupZh: "test", baselineCoverageZh: "test", ablationZh: "test", keyResults: [{ resultZh: "test", locator: "p. 3" }] },
    limitations: { authorsZh: [], reviewerRisksZh: ["test"] }, code: { status: "not-found", url: null },
    visuals: { methodFigure: { page: 2, label: "Fig. 1", reasonZh: "test" }, conceptFigure: null } };
  const reviewFile = path.join(run, "fulltext/reviews", `${sourceVersion}.json`); writeJson(reviewFile, review);
  const options = { root, reviewDirectory: path.dirname(reviewFile), screeningRunDirectory: run, researchConfig: "config.json", selection: "all-full-text" };
  assert.deepEqual(validateFulltextReviews(options).errors, []);
  review.source.pdfUrl = "https://example.com/wrong.pdf"; writeJson(reviewFile, review);
  assert.match(validateFulltextReviews(options).errors.join(" "), /source URLs/);
  review.source.pdfUrl = pdfUrl; writeJson(reviewFile, review);
  const papers = path.join(root, "content/paper-reading/papers"), digest = path.join(root, "content/paper-reading/digests/2026-10-16.json");
  writeJson(path.join(papers, "test.json"), { id: review.paperId, collectedAt: "2026-10-16", primaryTopicId: "lego", analysis: { sourceScope: "full_text", readingAction: "skim", relevance: "high", sourceNote: sourceVersion }, links: [{ label: "Paper", href: paperUrl }], abstractSourceUrl: paperUrl, abstractIsOriginal: true });
  writeJson(digest, { date: "2026-10-16", paperIds: [review.paperId] });
  assert.deepEqual(validatePromotion({ root, runDirectory: run, reviewDirectory: path.dirname(reviewFile), paperDirectory: papers, digest }).errors, []);

});

test("conference/backfill/update finalization cannot move the daily watermark", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "conference-watermark-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = path.join(root, "local-assets/paper-reading/runs/test");
  for (const mode of ["conference", "backfill", "updates"]) {
    writeJson(path.join(run, "manifest.json"), { window: { mode } });
    await assert.rejects(runFinalize({}, root, run), /cannot advance the daily watermark/);
  }
});
