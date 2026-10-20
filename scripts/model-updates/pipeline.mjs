#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeJsonAtomic } from "../paper-reading/lib/io.mjs";
import { hash, loadDataset, officialUrl, plainText, validateEvent } from "./lib.mjs";

export function parseBflIndex(html) {
  const posts = new Map();
  for (const match of html.matchAll(/<a\b[^>]*href=["'](\/blog\/[^"'#?]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const date = match[2].match(/<time\b[^>]*datetime=["']([^"']+)["']/i)?.[1];
    const title = match[2].match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1];
    if (!date || !title) continue;
    if (!Number.isFinite(Date.parse(date))) throw new Error("BFL index contains an invalid publication date.");
    const url = new URL(match[1], "https://bfl.ai").href;
    posts.set(url, { title: plainText(title), publishedAt: date.slice(0, 10), sourceUrl: url,
      description: plainText(match[2].match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "") });
  }
  if (!posts.size) throw new Error("BFL index has no dated articles; source format may have changed.");
  return [...posts.values()];
}

export function parseQwenIndex(data) {
  const articles = data?.data?.articles;
  if (data?.success !== true || !Array.isArray(articles) || !articles.length) throw new Error("Qwen article feed is unavailable or empty.");
  return articles.map((article) => {
    const date = article.extra?.date ?? article.published_at ?? article.publish_time ?? article.date;
    if (!article.id || !article.title || !Number.isFinite(Date.parse(date))) throw new Error("Qwen article metadata is incomplete.");
    return { title: plainText(article.title), publishedAt: new Date(date).toISOString().slice(0, 10),
      sourceUrl: `https://qwen.ai/blog?id=${encodeURIComponent(article.path ?? article.id)}`,
      description: plainText(article.extra?.description || article.extra?.introduction || article.description || article.summary || "") };
  });
}

export async function discoverUpdates({ root = process.cwd(), now = new Date().toISOString(), runId, fetchImpl = globalThis.fetch } = {}) {
  const dataset = await loadDataset(root);
  now = new Date(now).toISOString();
  runId ??= `updates-${now.replace(/[-:.]/g, "")}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) throw new Error("Invalid model-update run ID.");
  const run = path.join(root, "local-assets/model-updates/runs", runId);
  if (existsSync(path.join(run, "candidates.json"))) throw new Error("Run already exists; resume it without overwriting discovery.");
  const end = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  const start = new Date(Date.parse(`${end}T00:00:00Z`) - (dataset.config.lookbackDays - 1) * 86400_000).toISOString().slice(0, 10);
  const sources = [], candidates = [];
  const known = new Set(dataset.events.map((event) => event.sourceUrl));
  for (const publisher of dataset.config.publishers) {
    const status = { publisherId: publisher.id, status: "checked", checkedAt: now, fetched: 0, inWindow: 0, candidates: 0 };
    sources.push(status);
    try {
      const url = publisher.sourceUrls[0];
      const response = await fetchImpl(url, { headers: { "User-Agent": "personal-model-updates/0.1 (+https://zzzhy03.github.io/)", Accept: publisher.adapter === "bfl" ? "text/html" : "application/json" }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (response.url && !officialUrl(response.url, publisher)) throw new Error("Source redirected outside the configured official scope.");
      const text = await response.text();
      const posts = publisher.adapter === "bfl" ? parseBflIndex(text) : publisher.adapter === "qwen" ? parseQwenIndex(JSON.parse(text)) : (() => { throw new Error("Unknown publisher adapter."); })();
      status.fetched = posts.length;
      const snapshot = { url, retrievedAt: now, sha256: hash(text), posts };
      await writeJsonAtomic(path.join(run, "sources", `${publisher.id}.json`), snapshot);
      const unique = new Map(posts.map((post) => [post.sourceUrl, post]));
      if (publisher.adapter === "bfl" && posts.every((post) => post.publishedAt >= start)) {
        status.status = "partial";
        status.noteZh = "目录首页未覆盖完整检索时段，需要继续核对更早页面。";
      }
      for (const post of unique.values()) {
        if (!officialUrl(post.sourceUrl, publisher)) throw new Error("Article link is outside the official publisher scope.");
        if (post.publishedAt < start || post.publishedAt > end) continue;
        status.inWindow += 1;
        if (known.has(post.sourceUrl)) continue;
        candidates.push({ ...post, candidateId: `release-${hash(post.sourceUrl).slice(0, 20)}`, publisherId: publisher.id, sourceSnapshotSha256: hash(JSON.stringify(snapshot)), editorialStatus: "unreviewed" });
        status.candidates += 1;
      }
    } catch (error) { status.status = "failed"; status.noteZh = error.message; }
  }
  const payload = { schemaVersion: 1, runId, generatedAt: now, window: { start, end }, sources, candidates,
    reviewInstructionsZh: "只发布官方模型、技术报告、重大能力或权重开放事件；不按论文方向筛选。逐条读取原始公告，区分官方宣称与独立证据，合并同一发布的相关链接。普通应用、营销、第三方衍生与重复动态写明 skip 理由。不得宣称读过未取得的报告。" };
  await writeJsonAtomic(path.join(run, "candidates.json"), payload);
  await writeJsonAtomic(path.join(run, "manifest.json"), { schemaVersion: 1, runId, candidatesSha256: hash(JSON.stringify(payload)) });
  return { runDirectory: run, candidates: candidates.length, sources };
}

export async function publishUpdates({ root = process.cwd(), runDirectory, apply = false } = {}) {
  const run = path.resolve(root, runDirectory);
  if (path.dirname(run) !== path.resolve(root, "local-assets/model-updates/runs")) throw new Error("Expected a model-update run directly under its own runs root.");
  const dataset = await loadDataset(root);
  const payload = JSON.parse(await readFile(path.join(run, "candidates.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(run, "manifest.json"), "utf8"));
  if (manifest.runId !== payload.runId || path.basename(run) !== payload.runId || manifest.candidatesSha256 !== hash(JSON.stringify(payload))) throw new Error("Model-update discovery inputs changed after retrieval.");
  const review = JSON.parse(await readFile(path.join(run, "reviews.json"), "utf8"));
  if (review.runId !== payload.runId || !Number.isFinite(Date.parse(review.reviewedAt)) || !Array.isArray(review.decisions)) throw new Error("Invalid release review.");
  const byId = new Map(payload.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const seen = new Set(), writes = [], ids = new Set(dataset.events.map((event) => event.id)), urls = new Set(dataset.events.map((event) => event.sourceUrl));
  for (const decision of review.decisions) {
    const candidate = byId.get(decision.candidateId);
    if (!candidate || seen.has(decision.candidateId) || !decision.rationaleZh?.trim()) throw new Error("Every candidate needs exactly one explained decision.");
    seen.add(decision.candidateId);
    if (decision.decision === "skip") continue;
    if (decision.decision !== "publish") throw new Error("Release decisions must be publish or skip.");
    const source = JSON.parse(await readFile(path.join(run, "sources", `${candidate.publisherId}.json`), "utf8"));
    if (hash(JSON.stringify(source)) !== candidate.sourceSnapshotSha256 || !source.posts.some((post) => post.sourceUrl === candidate.sourceUrl && post.title === candidate.title && post.publishedAt === candidate.publishedAt)) throw new Error("Model update no longer matches its official source snapshot.");
    const event = validateEvent(decision.event, dataset.config);
    if (event.publisherId !== candidate.publisherId || event.sourceUrl !== candidate.sourceUrl || event.publishedAt !== candidate.publishedAt) throw new Error("Release must preserve its official publisher, date and source URL.");
    if (ids.has(event.id) || urls.has(event.sourceUrl)) {
      const prior = dataset.events.find((item) => item.id === event.id && item.sourceUrl === event.sourceUrl);
      if (!prior || JSON.stringify(prior) !== JSON.stringify(event)) throw new Error("Existing release differs; edit it explicitly instead of overwriting during discovery.");
      continue;
    }
    ids.add(event.id); urls.add(event.sourceUrl);
    writes.push(event);
  }
  if (seen.size !== byId.size) throw new Error("Some model-update candidates have no review decision.");
  const checks = { schemaVersion: 1, checkedAt: payload.generatedAt, sources: payload.sources };
  if (apply) {
    for (const event of writes) await writeJsonAtomic(path.join(root, "content/model-updates/events", `${event.id}.json`), event);
    if (!dataset.checks.checkedAt || Date.parse(checks.checkedAt) >= Date.parse(dataset.checks.checkedAt)) await writeJsonAtomic(path.join(root, "content/model-updates/checks.json"), checks);
    await writeJsonAtomic(path.join(run, "completion.json"), { schemaVersion: 1, runId: payload.runId, completedAt: new Date().toISOString(), publishedIds: review.decisions.filter((decision) => decision.decision === "publish").map((decision) => decision.event.id) });
  }
  return { dryRun: !apply, newEvents: writes.length, sourceCoverage: checks.sources };
}

async function main() {
  const args = process.argv.slice(2), command = args.shift() ?? "validate", options = {};
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === "--apply") options.apply = true;
    else if (["--run-dir", "--run-id", "--now"].includes(flag) && args[i + 1]) options[{ "--run-dir": "runDirectory", "--run-id": "runId", "--now": "now" }[flag]] = args[++i];
    else throw new Error(`Unknown model-update option '${flag}'.`);
  }
  if (command === "discover") console.log(JSON.stringify(await discoverUpdates(options), null, 2));
  else if (command === "publish") {
    if (!options.runDirectory) throw new Error("publish requires --run-dir.");
    console.log(JSON.stringify(await publishUpdates(options), null, 2));
  } else if (["validate", "build"].includes(command)) {
    const { publishers, checks, events } = await loadDataset();
    if (command === "build") {
      await mkdir("public/model-updates", { recursive: true });
      await writeJsonAtomic("public/model-updates/index.json", { publishers, checks, events });
    }
    console.log(`[model-updates] valid: ${publishers.length} publishers, ${events.length} events`);
  } else throw new Error("Use discover, publish, validate or build.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
