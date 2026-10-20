import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { computeDiscoveryWindow, classifyWindowMatch } from "../lib/window.mjs";
import { admissionErrors } from "../lib/admission.mjs";
import { discoverArxiv } from "../adapters/arxiv.mjs";

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
