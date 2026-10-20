import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { computeDiscoveryWindow, classifyWindowMatch } from "../lib/window.mjs";
import { admissionErrors } from "../lib/admission.mjs";
import { discoverArxiv } from "../adapters/arxiv.mjs";
import { normalizeOpenReviewNote, discoverOpenReview } from "../adapters/openreview.mjs";
import { parseCvfIndex, normalizeCrossrefWork, discoverVenueProceedings } from "../adapters/venue-proceedings.mjs";
import { selectConferenceEditions } from "../lib/pipeline-config.mjs";
import { mergeSourceDuplicates } from "../lib/dedupe.mjs";
import { buildExactDecisionIdentity } from "../decision-ledger.mjs";

test("daily never expands across downtime and excludes old revisions at inclusive boundaries", () => {
  const window = computeDiscoveryWindow({ state: { lastSuccessfulRunAt: "2026-02-01T00:00:00Z" }, now: "2026-10-16T00:00:00Z" });
  assert.equal(window.start, "2026-10-13T00:00:00.000Z");
  assert.equal(classifyWindowMatch({ publishedAt: "2026-05-01", updatedAt: "2026-10-15" }, window).inWindow, false);
  for (const publishedAt of [window.start, window.end]) assert.equal(classifyWindowMatch({ publishedAt }, window).inWindow, true);
  assert.equal(classifyWindowMatch({ publishedAt: "2026-10-16T00:00:01Z" }, window).inWindow, false);
  assert.equal(computeDiscoveryWindow({ now: window.end }).dateBasis, "published");
  assert.throws(() => computeDiscoveryWindow({ now: window.end, mode: "daily", since: "2026-01-01" }), /backfill/);
});

test("daily arXiv pushes submitted date to provider and locally rejects old/future records", async () => {
  const researchConfig = { directions: [{ id: "lego", search: { queryFamilies: [{ exactPhrases: ["lego"], anchors: [], actions: [] }] } }] };
  const window = computeDiscoveryWindow({ now: "2026-08-06T00:00:00Z" });
  const xml = await readFile(new URL("../fixtures/arxiv-window.atom.xml", import.meta.url), "utf8");
  const result = await discoverArxiv({ researchConfig, window, now: window.end, sleepImpl: async () => {}, fetchImpl: async (url) => {
    assert.equal(url.searchParams.get("sortBy"), "submittedDate"); assert.match(url.searchParams.get("search_query"), /submittedDate:\[202608030000 TO 202608060000\]/);
    return new Response(xml);
  } });
  assert.ok(result.records.length > 0);
  assert.ok(result.records.every((record) => Date.parse(record.publishedAt) >= Date.parse(window.start)));
});

test("broad topics require major progress or a concrete transfer, independent of quota", () => {
  const gate = { transferTopicIds: ["lego", "2d-design"] };
  const decision = { decision: "full-text-review", significance: "meaningful" };
  assert.equal(admissionErrors(decision, gate).length, 1);
  assert.deepEqual(admissionErrors({ ...decision, significance: "major" }, gate), []);
  assert.equal(admissionErrors({ ...decision, transferEvidence: { targetTopicId: "llm", mechanismZh: "x", benefitZh: "y", evidenceLocator: "abstract" } }, gate).length, 1);
  assert.deepEqual(admissionErrors({ ...decision, transferEvidence: { targetTopicId: "lego", mechanismZh: "约束生成表示", benefitZh: "满足积木连接", evidenceLocator: "Abstract, sentence 3" } }, gate), []);
});

const edition = { id: "iclr-2026", year: 2026, venueId: "iclr", provider: "openreview", venue: "ICLR.cc/2026/Conference" };
const note = { id: "abc", forum: "abc", cdate: Date.parse("2025-09-01"), mdate: Date.parse("2026-05-01"), content: {
  venueid: { value: edition.venue }, title: { value: "LEGO generation" }, authors: { value: ["A. Author"] }, abstract: { value: "LEGO model generation" }, pdf: { value: "/pdf?id=abc" } } };
const ctx = { now: "2026-10-16T00:00:00Z", conferenceEditions: [edition], sleepImpl: async () => {},
  researchConfig: { directions: [{ id: "lego", search: { queryFamilies: [{ exactPhrases: ["LEGO"], anchors: [], actions: [] }] } }] },
  venueRegistry: { venues: [{ id: "iclr", name: "ICLR", primaryTopicIds: ["lego"] }] } };

test("conference editions have explicit scope, preserve old submission dates and filter rejected notes", async () => {
  assert.equal(normalizeOpenReviewNote({ ...note, replyto: "abc" }, edition), null);
  assert.equal(normalizeOpenReviewNote({ ...note, content: { ...note.content, venueid: { value: edition.venue + "/Rejected_Submission" } } }, edition), null);
  const result = await discoverOpenReview({ ...ctx, fetchImpl: async (url) => {
    assert.equal(url.searchParams.get("content.venueid"), edition.venue);
    return Response.json({ notes: [note], count: 1 });
  } });
  assert.equal(result.status.status, "checked");
  assert.equal(result.records[0].publishedAt, "2025-09-01T00:00:00.000Z");
  const [merged] = mergeSourceDuplicates(result.records, ctx.venueRegistry);
  assert.equal(merged.windowMatch.changeKind, "conference"); assert.equal(merged.sourceNotes.conference.editionId, edition.id);
  const identity = buildExactDecisionIdentity(merged).identity;
  assert.match(identity.artifactKey, /^openreview:abc@source-/);
  const changed = structuredClone(merged); changed.sourceRecords[0].retrievedAt = "2026-10-20T00:00:00Z";
  assert.equal(buildExactDecisionIdentity(changed).identity.artifactKey, identity.artifactKey);
  changed.abstract += " revised"; assert.notEqual(buildExactDecisionIdentity(changed).identity.artifactKey, identity.artifactKey);
  assert.equal(selectConferenceEditions({ conferences: [{ ...edition, scanWindow: { start: "2026-01-01", end: "2026-05-31" } }] }, null, ctx.now).length, 0);
  assert.equal(selectConferenceEditions({ conferences: [edition] }, [edition.id], ctx.now).length, 1);
});

test("provider failure and empty/unreleased editions cannot claim successful coverage", async () => {
  for (const response of [new Response("denied", { status: 403 }), Response.json({ notes: [], count: 0 })]) {
    const result = await discoverOpenReview({ ...ctx, fetchImpl: async () => response });
    assert.equal(result.status.status, "failed"); assert.equal(result.records.length, 0);
  }
});

test("CVF metadata has official URLs and unknown dates, while Crossref excludes fuzzy venue/year matches", async () => {
  const cvf = { id: "cvpr-2026", year: 2026, venueId: "cvpr", provider: "cvf", indexUrl: "https://openaccess.thecvf.com/CVPR2026?day=all" };
  const html = '<dl><dt class="ptitle"><a href="/content/CVPR2026/html/Test_paper.html">LEGO &amp; generation</a></dt><dd><input name="query_author" value="Test Author"></dd><dd><a href="/content/CVPR2026/papers/Test_paper.pdf">pdf</a></dd></dl>';
  const [record] = parseCvfIndex(html, cvf);
  assert.equal(record.publishedAt, null); assert.equal(record.title, "LEGO & generation");
  const merged = mergeSourceDuplicates([{ ...record, year: 2026 }, { ...record, title: "Another paper", year: 2026 }], ctx.venueRegistry);
  assert.equal(merged.length, 2); assert.equal(merged[0].publishedAt, null);
  const result = await discoverVenueProceedings({ ...ctx, conferenceEditions: [cvf], fetchImpl: async () => new Response(html) });
  assert.equal(result.status.status, "checked"); assert.equal(result.records[0].sourceRecords[0].provider, "cvf");
  const siggraph = { year: 2026, containerTitle: "ACM SIGGRAPH 2026 Conference Papers" };
  const work = { DOI: "10.1145/test", title: ["LEGO generation"], author: [{ given: "One", family: "Author" }], "container-title": [siggraph.containerTitle], published: { "date-parts": [[2026, 7, 1]] } };
  assert.equal(normalizeCrossrefWork({ ...work, "container-title": ["ACM Transactions on Graphics"] }, siggraph), null);
  assert.equal(normalizeCrossrefWork({ ...work, published: { "date-parts": [[2025, 7, 1]] } }, siggraph), null);
  assert.equal(normalizeCrossrefWork(work, siggraph).publishedAt, "2026-07-01T00:00:00.000Z");
});
