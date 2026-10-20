import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const eventTypes = ["model-release", "technical-report", "capability-update", "weights-release"];
export const eventLabels = { "model-release": "模型发布", "technical-report": "技术报告", "capability-update": "能力更新", "weights-release": "权重开放" };
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export function plainText(text = "") {
  return String(text).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, code) => Number(code) <= 0x10ffff ? String.fromCodePoint(Number(code)) : " ")
    .replace(/\s+/g, " ").trim();
}
export function officialUrl(href, publisher) {
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    return publisher.officialOrigins.some((prefix) => {
      const scope = new URL(prefix);
      return url.origin === scope.origin && (scope.pathname === "/" || url.pathname === scope.pathname || url.pathname.startsWith(`${scope.pathname}/`));
    });
  } catch { return false; }
}
export function validateEvent(event, config) {
  const publisher = config.publishers.find((item) => item.id === event.publisherId);
  if (event.schemaVersion !== 1 || !publisher || !/^[a-z0-9][a-z0-9-]*$/.test(event.id ?? "")) throw new Error("Invalid model update identity/publisher.");
  for (const field of ["title", "model", "summaryZh", "availabilityZh", "evidenceNoteZh"]) {
    if (typeof event[field] !== "string" || !event[field].trim()) throw new Error(`${event.id}: missing ${field}.`);
  }
  if (!eventTypes.includes(event.eventType)) throw new Error(`${event.id}: invalid event type.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event.publishedAt) || !Number.isFinite(Date.parse(event.publishedAt)) || new Date(event.publishedAt).toISOString().slice(0, 10) !== event.publishedAt) throw new Error(`${event.id}: invalid publication date.`);
  if (!Number.isFinite(Date.parse(event.reviewedAt))) throw new Error(`${event.id}: missing review time.`);
  if (!officialUrl(event.sourceUrl, publisher)) throw new Error(`${event.id}: primary URL must belong to the configured publisher.`);
  if (!Array.isArray(event.changesZh) || !event.changesZh.length || event.changesZh.length > 5 || event.changesZh.some((text) => typeof text !== "string" || !text.trim())) throw new Error(`${event.id}: requires 1–5 concise changes.`);
  if (!Array.isArray(event.links) || !event.links.some((link) => link.href === event.sourceUrl)) throw new Error(`${event.id}: primary source link is missing.`);
  for (const link of event.links) {
    let url;
    try { url = new URL(link.href); } catch { throw new Error(`${event.id}: invalid link.`); }
    if (!link.label?.trim() || url.protocol !== "https:" || url.username || url.password) throw new Error(`${event.id}: invalid link.`);
  }
  if (Object.hasOwn(event, "topicIds") || Object.hasOwn(event, "primaryTopicId")) throw new Error(`${event.id}: model updates are independent of paper topics.`);
  return event;
}
export async function loadDataset(root = process.cwd()) {
  const base = path.join(root, "content/model-updates");
  const config = JSON.parse(await readFile(path.join(base, "config.json"), "utf8"));
  if (config.schemaVersion !== 1 || !Number.isInteger(config.lookbackDays) || config.lookbackDays < 1 || !Array.isArray(config.publishers)) throw new Error("Invalid model update config.");
  const publisherIds = new Set();
  for (const publisher of config.publishers) {
    if (!/^[a-z0-9-]+$/.test(publisher.id) || publisherIds.has(publisher.id) || !publisher.name || !Array.isArray(publisher.officialOrigins) || !Array.isArray(publisher.sourceUrls)) throw new Error("Invalid/duplicate publisher config.");
    publisherIds.add(publisher.id);
    for (const url of publisher.sourceUrls) if (!officialUrl(url, publisher)) throw new Error("Source URL is outside its official publisher scope.");
  }
  const directory = path.join(base, "events");
  const files = await readdir(directory).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  const events = await Promise.all(files.filter((name) => name.endsWith(".json")).map(async (file) => {
    const event = validateEvent(JSON.parse(await readFile(path.join(directory, file), "utf8")), config);
    if (file !== `${event.id}.json`) throw new Error("Event filename must match its ID.");
    return event;
  }));
  if (new Set(events.map((event) => event.id)).size !== events.length || new Set(events.map((event) => event.sourceUrl)).size !== events.length) throw new Error("Duplicate model update ID/source URL.");
  const checks = JSON.parse(await readFile(path.join(base, "checks.json"), "utf8"));
  if (checks.schemaVersion !== 1 || !Array.isArray(checks.sources)) throw new Error("Invalid source checks.");
  for (const source of checks.sources) {
    if (!publisherIds.has(source.publisherId) || !["checked", "partial", "failed"].includes(source.status)) throw new Error("Invalid source coverage.");
  }
  return { config, publishers: config.publishers.map(({ id, name, homeUrl }) => ({ id, name, homeUrl })),
    checks, events: events.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.title.localeCompare(b.title)) };
}
