#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readJson, readJsonIfPresent, writeJsonAtomic } from "./lib/io.mjs";
import { DEFAULT_PIPELINE_CONFIG } from "./lib/pipeline-config.mjs";

const GiB = 1024 ** 3;
const sha = (data) => createHash("sha256").update(data).digest("hex");
async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function regularInside(root, file) {
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Path escapes ${root}: ${file}`);
  let cursor = root;
  if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`Symlink is not allowed: ${cursor}`);
  for (const part of rel.split(path.sep)) {
    cursor = path.join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`Symlink is not allowed: ${cursor}`);
  }
  if (!(await lstat(file)).isFile()) throw new Error(`Not a regular file: ${file}`);
}
async function filesIn(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}
function receiptArtifacts(receipt) {
  return [receipt.discovery?.manifest, receipt.discovery?.candidateArtifact, receipt.screening?.manifest,
    receipt.screening?.decisionLedgerSnapshot, ...(receipt.screening?.reviews ?? []),
    ...(receipt.fulltext?.reviews ?? []), receipt.fulltext?.backlog?.file ? receipt.fulltext.backlog : null,
    receipt.decisionLedger?.delta, ...(receipt.withdrawals ?? []).flatMap((item) => [item.notice, item.review])].filter(Boolean);
}

export async function planCache({ root = process.cwd(), now = new Date().toISOString(), runDirectory } = {}) {
  root = path.resolve(root);
  if (!Number.isFinite(Date.parse(now))) throw new Error("Invalid cleanup time.");
  const runsRoot = path.join(root, "local-assets/paper-reading/runs");
  const selectedRun = runDirectory ? path.resolve(root, runDirectory) : null;
  if (selectedRun && path.dirname(selectedRun) !== runsRoot) throw new Error("Expected one run directly under runs/.");
  const state = await readJsonIfPresent(path.join(root, "content/paper-reading/state/discovery-state.json"), null);
  const pdfs = (await filesIn(selectedRun ?? runsRoot)).filter((file) => file.endsWith(".pdf"));
  const sizes = new Map(await Promise.all(pdfs.map(async (file) => [file, (await lstat(file)).size])));
  const eligible = new Map(), warnings = [];
  for (const receiptFile of (await filesIn(path.join(root, "content/paper-reading/runs"))).filter((file) => file.endsWith(".json"))) {
    const receipt = await readJson(receiptFile);
    if (receipt.status !== "content-verified" || !/^[a-zA-Z0-9._-]+$/.test(receipt.runId)) continue;
    const run = path.join(runsRoot, receipt.runId);
    if (selectedRun && run !== selectedRun) continue;
    try {
      const end = receipt.discovery?.window?.end;
      const mode = receipt.discovery?.window?.mode ?? "daily";
      if (mode === "daily" && (!Number.isFinite(Date.parse(end)) || !Number.isFinite(Date.parse(state?.lastSuccessfulRunAt)) || Date.parse(end) > Date.parse(state.lastSuccessfulRunAt))) {
        throw new Error("Daily run is not covered by the completed watermark; protected.");
      }
      const artifacts = receiptArtifacts(receipt);
      if (!artifacts.length || !Number.isFinite(Date.parse(receipt.generatedAt))) throw new Error("Incomplete verified receipt.");
      // Check the immutable input/review/delta chain, not mutable later canonical versions.
      for (const artifact of artifacts) {
        const file = path.resolve(root, artifact.file);
        await regularInside(run, file);
        if (await hashFile(file) !== artifact.sha256) throw new Error(`Receipt hash mismatch: ${artifact.file}`);
      }
      for (const artifact of receipt.fulltext?.reviews ?? []) {
        const review = await readJson(path.resolve(root, artifact.file));
        if (review.source?.scope !== "full_text" || !review.source.pdfPath) continue;
        const file = path.resolve(root, review.source.pdfPath);
        if (!sizes.has(file)) continue;
        if (path.dirname(file) !== path.join(run, "fulltext/sources")) continue;
        await regularInside(run, file);
        const sourceUrl = review.arxivVersion ? `https://arxiv.org/pdf/${review.arxivVersion}` : review.source.pdfUrl;
        if (!sourceUrl || !/^https:\/\//.test(sourceUrl) || !/^[a-f0-9]{64}$/.test(review.source.pdfSha256)) continue;
        eligible.set(file, { file: path.relative(root, file), runId: receipt.runId, bytes: sizes.get(file),
          sha256: review.source.pdfSha256, sourceUrl, pageCount: review.source.pageCount,
          review: artifact, receipt: { file: path.relative(root, receiptFile), sha256: await hashFile(receiptFile) },
          completedAt: receipt.generatedAt });
      }
    } catch (error) {
      for (const [file, target] of eligible) if (target.runId === receipt.runId) eligible.delete(file);
      warnings.push({ runId: receipt.runId, reason: error.message });
    }
  }
  const totalBytes = [...sizes.values()].reduce((sum, size) => sum + size, 0);
  let remainingBytes = totalBytes;
  const targets = [];
  for (const target of [...eligible.values()].sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.file.localeCompare(b.file))) {
    // Verify bytes before making any deletion proposal; corrupt evidence is never disposable.
    if (await hashFile(path.resolve(root, target.file)) !== target.sha256) {
      warnings.push({ file: target.file, reason: "PDF differs from reviewed hash; protected." });
      continue;
    }
    targets.push({ ...target, reason: "review-verified" });
    remainingBytes -= target.bytes;
  }
  return { schemaVersion: 1, kind: "paper-reading-cache-plan", generatedAt: now, root,
    policy: { pdfRetention: "until-verified" }, totalPdfCount: pdfs.length, totalBytes,
    protectedPdfCount: pdfs.length - eligible.size, targetCount: targets.length,
    reclaimableBytes: totalBytes - remainingBytes, remainingBytes,
    warnings, targets };
}

export async function applyCachePlan(plan) {
  const root = path.resolve(plan.root);
  let removedBytes = 0, removedCount = 0;
  for (const target of plan.targets) {
    const run = path.join(root, "local-assets/paper-reading/runs", target.runId);
    const file = path.resolve(root, target.file);
    if (path.dirname(file) !== path.join(run, "fulltext/sources") || !file.endsWith(".pdf")) throw new Error("Invalid cache target.");
    await regularInside(run, file);
    for (const artifact of [target.review, target.receipt]) {
      await regularInside(root, path.resolve(root, artifact.file));
      if (await hashFile(path.resolve(root, artifact.file)) !== artifact.sha256) throw new Error("Evidence changed after planning; stopped.");
    }
    const review = await readJson(path.resolve(root, target.review.file));
    const receipt = await readJson(path.resolve(root, target.receipt.file));
    if (review.runId !== target.runId || path.resolve(root, review.source.pdfPath) !== file ||
        review.source.pdfSha256 !== target.sha256 ||
        receipt.runId !== target.runId || !receipt.fulltext?.reviews?.some((item) => item.file === target.review.file && item.sha256 === target.review.sha256)) {
      throw new Error("Cache target is not bound to its reviewed receipt.");
    }
    if (await hashFile(file) !== target.sha256) throw new Error("PDF changed after planning; stopped.");
    const manifestFile = path.join(run, "fulltext/source-cache.json");
    const manifest = await readJsonIfPresent(manifestFile, { schemaVersion: 1, kind: "paper-reading-source-cache", runId: target.runId, entries: [] });
    const entry = { ...target, evictedAt: new Date().toISOString() };
    manifest.entries = [...manifest.entries.filter((item) => item.file !== target.file), entry];
    // Journal exact URL/hash/evidence before unlinking; interrupted runs remain recoverable.
    await writeJsonAtomic(manifestFile, manifest);
    await unlink(file);
    removedBytes += target.bytes; removedCount += 1;
  }
  return { removedCount, removedBytes };
}

export async function removeVerifiedSources({ root = process.cwd(), runDirectory } = {}) {
  const config = await readJsonIfPresent(path.join(root, "content/paper-reading/pipeline-config.json"), DEFAULT_PIPELINE_CONFIG);
  if (config.storage.automaticPrune !== true) return { enabled: false, removedCount: 0, removedBytes: 0 };
  if (config.storage.pdfRetention !== "until-verified") throw new Error("Unsupported PDF retention policy.");
  const plan = await planCache({ root, runDirectory });
  const applied = await applyCachePlan(plan);
  return { enabled: true, ...applied, protectedPdfCount: plan.protectedPdfCount, warnings: plan.warnings };
}

export async function restoreCache({ root = process.cwd(), runDirectory, fetchImpl = globalThis.fetch }) {
  root = path.resolve(root);
  const run = path.resolve(root, runDirectory);
  if (path.dirname(run) !== path.join(root, "local-assets/paper-reading/runs")) throw new Error("Expected one run directly under runs/.");
  const manifestFile = path.join(run, "fulltext/source-cache.json");
  await regularInside(run, manifestFile);
  const manifest = await readJson(manifestFile);
  let restored = 0;
  for (const entry of manifest.entries) {
    const file = path.resolve(root, entry.file);
    if (path.dirname(file) !== path.join(run, "fulltext/sources") || !file.endsWith(".pdf")) throw new Error("Invalid restore destination.");
    await regularInside(run, path.resolve(root, entry.review.file));
    if (await hashFile(path.resolve(root, entry.review.file)) !== entry.review.sha256) throw new Error("Reviewed evidence changed; cannot restore.");
    const review = await readJson(path.resolve(root, entry.review.file));
    const expectedUrl = review.arxivVersion ? `https://arxiv.org/pdf/${review.arxivVersion}` : review.source.pdfUrl;
    if (review.source.pdfSha256 !== entry.sha256 || expectedUrl !== entry.sourceUrl || path.resolve(root, review.source.pdfPath) !== file) throw new Error("Cache manifest disagrees with reviewed source/hash.");
    const existing = await lstat(file).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (existing) {
      await regularInside(run, file);
      if (await hashFile(file) !== entry.sha256) throw new Error("Existing PDF differs; refusing overwrite.");
      continue;
    }
    const response = await fetchImpl(entry.sourceUrl, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Restore HTTP ${response.status}: ${entry.sourceUrl}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha(bytes) !== entry.sha256) throw new Error(`Downloaded bytes differ from reviewed version: ${entry.sourceUrl}`);
    await mkdir(path.dirname(file), { recursive: true });
    // Validate the destination's ancestors even while the PDF itself is absent.
    await regularInside(run, path.resolve(root, entry.review.file));
    for (const directory of [path.join(run, "fulltext"), path.dirname(file)]) {
      if ((await lstat(directory)).isSymbolicLink()) throw new Error("Restore refuses symlink directories.");
    }
    const temporary = `${file}.${process.pid}.restore`;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, file);
    restored += 1;
  }
  return { restored };
}

async function main() {
  const args = process.argv.slice(2), command = args.shift() ?? "audit", options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--json") options.json = true;
    else if (["--run-dir", "--report"].includes(arg)) {
      if (!args[i + 1]) throw new Error(`${arg} needs a value.`);
      const field = { "--run-dir": "runDirectory", "--report": "report" }[arg];
      options[field] = args[++i];
    } else throw new Error(`Unknown cache option ${arg}`);
  }
  if (command === "restore") {
    if (!options.runDirectory) throw new Error("restore requires --run-dir.");
    console.log(JSON.stringify(await restoreCache(options), null, 2)); return;
  }
  if (!["audit", "prune"].includes(command)) throw new Error("Use cache:papers audit|prune|restore.");
  if (command === "audit" && options.apply) throw new Error("audit never mutates; use prune --apply.");
  const plan = await planCache(options);
  if (options.report) await writeJsonAtomic(path.resolve(options.report), plan);
  const applied = options.apply ? await applyCachePlan(plan) : null;
  if (options.json) console.log(JSON.stringify({ ...plan, applied }, null, 2));
  else console.log(JSON.stringify({ totalPdfs: plan.totalPdfCount, totalGiB: +(plan.totalBytes / GiB).toFixed(3),
    reclaimablePdfs: plan.targetCount, reclaimableGiB: +(plan.reclaimableBytes / GiB).toFixed(3),
    remainingGiB: +(plan.remainingBytes / GiB).toFixed(3), protectedPdfs: plan.protectedPdfCount,
    warnings: plan.warnings, applied, dryRun: !options.apply }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`[paper-cache] ${error.message}`); process.exitCode = 1; });
}
