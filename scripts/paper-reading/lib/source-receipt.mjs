import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function readRegular(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Evidence path escapes its root.");
  let cursor = root;
  for (const part of ["", ...relative.split(path.sep)]) {
    cursor = path.join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error("Evidence path is a symlink.");
  }
  if (!lstatSync(file).isFile()) throw new Error("Evidence must be a regular file.");
  return readFileSync(file);
}

// A historical receipt proves the original check. This never claims to re-check absent bytes.
export function verifyRemovedPdf({ root, reviewFile, review }) {
  try {
    root = path.resolve(root);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(review.runId)) throw new Error("Invalid run identity.");
    const run = path.join(root, "local-assets/paper-reading/runs", review.runId);
    if (path.dirname(reviewFile) !== path.join(run, "fulltext/reviews")) throw new Error("Review is outside its run.");
    const reviewBytes = readRegular(root, reviewFile);
    const manifest = JSON.parse(readRegular(root, path.join(run, "fulltext/source-cache.json")));
    if (manifest.kind !== "paper-reading-source-cache" || manifest.runId !== review.runId) throw new Error("Invalid source removal manifest.");
    const entries = manifest.entries.filter((item) => path.resolve(root, item.file) === path.resolve(root, review.source.pdfPath));
    if (entries.length !== 1) throw new Error("Missing or ambiguous source removal entry.");
    const entry = entries[0];
    const sourceUrl = review.arxivVersion ? `https://arxiv.org/pdf/${review.arxivVersion}` : review.source.pdfUrl;
    if (entry.runId !== review.runId || entry.sha256 !== review.source.pdfSha256 || entry.pageCount !== review.source.pageCount ||
        entry.sourceUrl !== sourceUrl || path.resolve(root, entry.review.file) !== reviewFile || entry.review.sha256 !== sha(reviewBytes) ||
        !Number.isFinite(Date.parse(entry.evictedAt))) throw new Error("Removed-source proof no longer matches the review.");
    const receiptFile = path.resolve(root, entry.receipt.file);
    if (path.dirname(receiptFile) !== path.join(root, "content/paper-reading/runs")) throw new Error("Receipt is outside the canonical receipt directory.");
    const receiptBytes = readRegular(root, receiptFile);
    if (sha(receiptBytes) !== entry.receipt.sha256) throw new Error("Receipt changed after source removal.");
    const receipt = JSON.parse(receiptBytes);
    if (receipt.status !== "content-verified" || receipt.runId !== review.runId ||
        !receipt.fulltext?.reviews?.some((item) => item.file === entry.review.file && item.sha256 === entry.review.sha256)) {
      throw new Error("Receipt does not certify this review.");
    }
    if ((receipt.discovery?.window?.mode ?? "daily") === "daily") {
      const state = JSON.parse(readRegular(root, path.join(root, "content/paper-reading/state/discovery-state.json")));
      const end = Date.parse(receipt.discovery?.window?.end), completed = Date.parse(state.lastSuccessfulRunAt);
      if (!Number.isFinite(end) || !Number.isFinite(completed) || end > completed) throw new Error("Daily run was not finalized.");
    }
    return { valid: true, receipt: entry.receipt.file, sourceValidation: "previously-verified-receipt" };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}
