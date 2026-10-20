import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { discoverUpdates, parseBflIndex, parseQwenIndex, publishUpdates } from "../pipeline.mjs";
import { loadDataset, officialUrl, validateEvent } from "../lib.mjs";

const config = { schemaVersion: 1, lookbackDays: 7, publishers: [{ id: "qwen", name: "Qwen", homeUrl: "https://qwen.ai/", adapter: "qwen", sourceUrls: ["https://qwen.ai/api/v2/article/retrieval?type=qwen_ai&language=en-US"], officialOrigins: ["https://qwen.ai", "https://github.com/QwenLM"] }] };
const post = { id: "note-id", path: "qwen-test", title: "Qwen Test", extra: { date: "2026-10-15T12:00:00Z", introduction: "Official model release" } };
const event = { schemaVersion: 1, id: "qwen-test", publisherId: "qwen", model: "Qwen Test", title: "Qwen Test", eventType: "model-release", publishedAt: "2026-10-15", reviewedAt: "2026-10-16T00:00:00Z", sourceUrl: "https://qwen.ai/blog?id=qwen-test", summaryZh: "官方模型更新。", changesZh: ["新增能力。"], availabilityZh: "官方提供。", evidenceNoteZh: "依据官方公告，未独立复现。", links: [{ label: "官方公告", href: "https://qwen.ai/blog?id=qwen-test" }] };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "model-updates-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "content/model-updates"), { recursive: true });
  await writeFile(path.join(root, "content/model-updates/config.json"), JSON.stringify(config));
  await writeFile(path.join(root, "content/model-updates/checks.json"), JSON.stringify({ schemaVersion: 1, checkedAt: null, sources: [] }));
  await mkdir(path.join(root, "content/paper-reading/state"), { recursive: true });
  await writeFile(path.join(root, "content/paper-reading/state/discovery-state.json"), "paper watermark sentinel");
  return root;
}

test("official source parsers preserve dated posts and fail on format changes", () => {
  assert.equal(parseQwenIndex({ success: true, data: { articles: [post] } })[0].sourceUrl, event.sourceUrl);
  const html = '<a href="/blog/model"><article><h2>FLUX &amp; Models</h2><time dateTime="2026-10-15T15:00:00Z">Oct 15</time></article></a>';
  assert.equal(parseBflIndex(html)[0].title, "FLUX & Models");
  assert.throws(() => parseBflIndex('<a href="/blog">No entries</a>'), /no dated articles/);
  assert.throws(() => parseQwenIndex({ success: true, data: { articles: [] } }), /empty/);
});

test("publication is separately reviewed, idempotent and cannot change paper state", async (t) => {
  const root = await fixture(t);
  const fetchImpl = async () => Response.json({ success: true, data: { articles: [post, post, { ...post, id: "old", path: "old", extra: { date: "2026-10-01T12:00:00Z" } }] } });
  const result = await discoverUpdates({ root, now: "2026-10-16T00:00:00Z", runId: "first", fetchImpl });
  assert.equal(result.candidates, 1); assert.equal((await loadDataset(root)).events.length, 0);
  const payload = JSON.parse(await readFile(path.join(result.runDirectory, "candidates.json"), "utf8"));
  const reviews = { runId: "first", reviewedAt: event.reviewedAt, decisions: [{ candidateId: payload.candidates[0].candidateId, decision: "publish", rationaleZh: "重点模型官方发布。", event }] };
  await writeFile(path.join(result.runDirectory, "reviews.json"), JSON.stringify(reviews));
  assert.equal((await publishUpdates({ root, runDirectory: result.runDirectory })).newEvents, 1);
  assert.equal((await loadDataset(root)).events.length, 0);
  await publishUpdates({ root, runDirectory: result.runDirectory, apply: true });
  assert.equal((await loadDataset(root)).events.length, 1);
  assert.equal((await publishUpdates({ root, runDirectory: result.runDirectory, apply: true })).newEvents, 0);
  assert.equal(await readFile(path.join(root, "content/paper-reading/state/discovery-state.json"), "utf8"), "paper watermark sentinel");
  assert.equal((await discoverUpdates({ root, now: "2026-10-16T00:00:00Z", runId: "second", fetchImpl })).candidates, 0);
  await assert.rejects(discoverUpdates({ root, now: event.reviewedAt, runId: "first", fetchImpl }), /already exists/);
});

test("source failures remain visible, without blocking the separate paper workflow", async (t) => {
  const root = await fixture(t);
  const result = await discoverUpdates({ root, now: event.reviewedAt, runId: "failed", fetchImpl: async () => new Response("unavailable", { status: 503 }) });
  assert.equal(result.candidates, 0); assert.equal(result.sources[0].status, "failed");
  assert.equal(await readFile(path.join(root, "content/paper-reading/state/discovery-state.json"), "utf8"), "paper watermark sentinel");
});

test("review cannot relabel publisher/date, forge the source, or introduce paper topics", async (t) => {
  assert.equal(officialUrl("https://qwen.ai.evil.example/blog", config.publishers[0]), false);
  assert.equal(officialUrl("https://github.com/QwenLM-fake/repo", config.publishers[0]), false);
  assert.throws(() => validateEvent({ ...event, topicIds: ["vlm-mllm"] }, config), /independent/);
  const root = await fixture(t);
  const result = await discoverUpdates({ root, now: event.reviewedAt, runId: "tamper", fetchImpl: async () => Response.json({ success: true, data: { articles: [post] } }) });
  const payload = JSON.parse(await readFile(path.join(result.runDirectory, "candidates.json"), "utf8"));
  await writeFile(path.join(result.runDirectory, "reviews.json"), JSON.stringify({ runId: "tamper", reviewedAt: event.reviewedAt, decisions: [{ candidateId: payload.candidates[0].candidateId, decision: "publish", rationaleZh: "test", event: { ...event, publishedAt: "2026-10-16" } }] }));
  await assert.rejects(publishUpdates({ root, runDirectory: result.runDirectory, apply: true }), /preserve/);
  payload.candidates[0].title = "tampered";
  await writeFile(path.join(result.runDirectory, "candidates.json"), JSON.stringify(payload));
  await assert.rejects(publishUpdates({ root, runDirectory: result.runDirectory }), /changed after retrieval/);
});
