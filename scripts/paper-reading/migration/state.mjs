import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  SHA256, COMMIT, ID, sha256, jsonBytes, relativePath, inside, regularBytes,
  walk, verifyRecord, assertNoCredentials, writeImmutable,
} from "./files.mjs";

export const STATE_SCHEMA = 1;
const RUN_PREFIX = "local-assets/paper-reading/runs/";
const CONTENT_PREFIX = "content/paper-reading/";
const RUN_ROLES = [
  [/^manifest\.json$/, "discovery-manifest"],
  [/^candidates\.json$/, "candidates"],
  [/^screening\/screening-manifest\.json$/, "screening-manifest"],
  [/^screening\/decision-ledger-input\.json$/, "ledger-input"],
  [/^screening\/batches\/[A-Za-z0-9._-]+\.input\.json$/, "screening-input"],
  [/^screening\/reviews\/[A-Za-z0-9._-]+\.review\.json$/, "screening-review"],
  [/^fulltext\/reviews\/[A-Za-z0-9._-]+\.json$/, "fulltext-review"],
  [/^fulltext\/(summary|backlog|source-cache)\.json$/, "fulltext-state"],
  [/^decision-ledger\/delta\.json$/, "ledger-delta"],
];

export function artifactRole(file, withdrawalNotices = new Set()) {
  relativePath(file);
  if (file.startsWith(CONTENT_PREFIX)) {
    const rest = file.slice(CONTENT_PREFIX.length);
    if (/^(topics|research-config|venue-registry|pipeline-config)\.json$/.test(rest)) return "configuration";
    if (/^state\/(discovery-state|decision-ledger)\.json$/.test(rest)) return "aggregate-state";
    if (/^(papers|digests|runs)\/[A-Za-z0-9._-]+\.json$/.test(rest)) {
      return { papers: "canonical-paper", digests: "digest", runs: "receipt" }[rest.split("/")[0]];
    }
  }
  if (file.startsWith(RUN_PREFIX)) {
    const [runId, ...parts] = file.slice(RUN_PREFIX.length).split("/");
    if (!ID.test(runId)) return null;
    const rest = parts.join("/");
    for (const [pattern, role] of RUN_ROLES) if (pattern.test(rest)) return role;
    if (withdrawalNotices.has(file) && /^fulltext\/sources\/[A-Za-z0-9._/-]+\.(html|txt|json)$/.test(rest)) {
      return "withdrawal-notice";
    }
  }
  return null;
}

function checkRunIdentity(file, role, bytes) {
  if (!file.startsWith(RUN_PREFIX) || role === "withdrawal-notice") return;
  const runId = file.slice(RUN_PREFIX.length).split("/")[0];
  const value = JSON.parse(bytes);
  if ((value.runId !== undefined && value.runId !== runId) ||
      (["discovery-manifest", "candidates", "screening-manifest", "ledger-delta", "fulltext-review"].includes(role) && value.runId !== runId)) {
    throw new Error("Artifact run identity does not match its directory.");
  }
}

function exclusion(file, type) {
  if (type !== "file") return type;
  if (/\.pdf$/i.test(file)) return "pdf-excluded";
  if (/\/fulltext\/work\//.test(file)) return "rebuildable-work";
  if (/\/(audit|verification|publication)\//.test(file)) return "historical-audit-or-log";
  if (/\/fulltext\/sources\//.test(file)) return "unselected-source-evidence";
  return "outside-explicit-allowlist";
}

export function inventoryState(root) {
  root = path.resolve(root);
  const candidates = [...walk(root, CONTENT_PREFIX.slice(0, -1)), ...walk(root, RUN_PREFIX.slice(0, -1))];
  const notices = new Map();
  const blocked = [];
  for (const entry of candidates.filter((entry) => artifactRole(entry.path) === "receipt")) {
    try {
      const bytes = regularBytes(root, entry.path);
      assertNoCredentials(bytes, { json: true });
      const receipt = JSON.parse(bytes);
      for (const event of receipt.withdrawals ?? []) {
        const file = relativePath(event.notice?.file);
        if (!artifactRole(file, new Set([file])) || !SHA256.test(event.notice?.sha256)) {
          throw new Error("Invalid withdrawal notice pin.");
        }
        if (notices.has(file) && notices.get(file) !== event.notice.sha256) throw new Error("Conflicting notice pins.");
        notices.set(file, event.notice.sha256);
      }
    } catch {
      blocked.push({ path: entry.path, reason: "receipt-preflight-failed-values-suppressed" });
    }
  }
  const files = [], excluded = [];
  const noticePaths = new Set(notices.keys());
  for (const entry of candidates) {
    const role = artifactRole(entry.path, noticePaths);
    if (!role) { excluded.push({ ...entry, reason: exclusion(entry.path, entry.type) }); continue; }
    try {
      if (entry.type !== "file") throw new Error("Not a regular file.");
      const bytes = regularBytes(root, entry.path);
      assertNoCredentials(bytes, { json: role !== "withdrawal-notice" || entry.path.endsWith(".json") });
      checkRunIdentity(entry.path, role, bytes);
      const digest = sha256(bytes);
      if (role === "withdrawal-notice" && notices.get(entry.path) !== digest) throw new Error("Notice changed.");
      files.push({ path: entry.path, role, bytes: bytes.length, sha256: digest });
    } catch {
      blocked.push({ path: entry.path, reason: "artifact-preflight-failed-values-suppressed" });
    }
  }
  for (const file of noticePaths) {
    if (!files.some((entry) => entry.path === file)) blocked.push({ path: file, reason: "required-notice-unavailable" });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    schemaVersion: STATE_SCHEMA, files, excluded, blocked,
    fileCount: files.length, bytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
    includesPdf: false,
    fields: "Selected artifacts retain every original field and byte; no redaction or path rewriting.",
  };
}

function validateContext(context) {
  if (!context || !COMMIT.test(context.repositoryBaseCommit) || !SHA256.test(context.codeSnapshotSha256)) {
    throw new Error("A repository base commit and code snapshot SHA-256 are required.");
  }
  if (Object.keys(context).some((key) => !["repositoryBaseCommit", "codeSnapshotSha256"].includes(key))) {
    throw new Error("Unsupported bundle context field.");
  }
}

export function exportState({ root, destination, context }) {
  validateContext(context);
  const inventory = inventoryState(root);
  if (inventory.blocked.length) throw new Error(`Export blocked for ${inventory.blocked.length} artifact(s); inspect inventory.`);
  if (!inventory.files.length) throw new Error("No allowlisted state artifacts.");
  destination = path.resolve(destination);
  const relativeDestination = path.relative(path.resolve(root), destination);
  if (!relativeDestination || (!relativeDestination.startsWith(`..${path.sep}`) && relativeDestination !== ".." && !path.isAbsolute(relativeDestination))) {
    throw new Error("Export destination must be outside the source root.");
  }
  inside(path.dirname(destination), path.basename(destination), { missing: true });
  if (existsSync(destination)) throw new Error("Export destination already exists.");
  const manifest = {
    schemaVersion: STATE_SCHEMA, kind: "paper-reading-state-bundle", context,
    files: inventory.files,
  };
  const bytes = jsonBytes(manifest);
  const staging = `${destination}.staging-${randomUUID()}`;
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    for (const entry of manifest.files) {
      writeImmutable(staging, `files/${entry.path}`, verifyRecord(root, entry));
    }
    writeFileSync(path.join(staging, "manifest.json"), bytes, { flag: "wx", mode: 0o600 });
    // Recheck the complete source set after export; reject a concurrently changing run.
    const current = inventoryState(root);
    if (current.blocked.length || JSON.stringify(current.files) !== JSON.stringify(inventory.files)) {
      throw new Error("State changed while exporting.");
    }
    renameSync(staging, destination);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { manifestSha256: sha256(bytes), fileCount: inventory.fileCount, bytes: inventory.bytes };
}

export function verifyBundle({ bundle, manifestSha256 }) {
  if (!SHA256.test(manifestSha256)) throw new Error("An independently pinned manifest SHA-256 is required.");
  const bytes = regularBytes(bundle, "manifest.json");
  if (sha256(bytes) !== manifestSha256) throw new Error("Manifest hash mismatch.");
  assertNoCredentials(bytes, { json: true });
  const manifest = JSON.parse(bytes);
  if (manifest.schemaVersion !== STATE_SCHEMA || manifest.kind !== "paper-reading-state-bundle" ||
      !Array.isArray(manifest.files) || !manifest.files.length) throw new Error("Unsupported state bundle.");
  validateContext(manifest.context);
  const seen = new Set(), noticePaths = new Set(), payloads = new Map();
  // Validate paths before reading any payload, then resolve notice pins from verified receipts.
  for (const entry of manifest.files) {
    relativePath(entry.path);
    if (seen.has(entry.path)) throw new Error("Duplicate artifact path.");
    seen.add(entry.path);
    const content = verifyRecord(bundle, { ...entry, path: `files/${entry.path}` });
    assertNoCredentials(content, { json: entry.path.endsWith(".json") });
    payloads.set(entry.path, content);
    if (entry.role === "receipt") {
      for (const event of JSON.parse(content).withdrawals ?? []) noticePaths.add(relativePath(event.notice?.file));
    }
  }
  for (const entry of manifest.files) {
    if (!entry.role || artifactRole(entry.path, noticePaths) !== entry.role) throw new Error("Unknown artifact role.");
    checkRunIdentity(entry.path, entry.role, payloads.get(entry.path));
    if (entry.role === "receipt") {
      for (const event of JSON.parse(payloads.get(entry.path)).withdrawals ?? []) {
        const notice = payloads.get(event.notice.file);
        if (!notice || sha256(notice) !== event.notice.sha256) throw new Error("Missing or changed notice.");
      }
    }
  }
  const actual = walk(bundle, "files").map((entry) => {
    if (entry.type !== "file") throw new Error("Unexpected bundle entry.");
    return entry.path.slice(6);
  });
  if (actual.length !== seen.size || actual.some((file) => !seen.has(file))) throw new Error("Unmanifested bundle file.");
  return { manifest, payloads };
}

// Installs only verified missing files. Existing bytes must match exactly.
// An interrupted installation is safe to replay; changed existing files are never overwritten.
export function restoreState({ bundle, target, manifestSha256, expectedContext }) {
  const { manifest, payloads } = verifyBundle({ bundle, manifestSha256 });
  validateContext(expectedContext);
  if (Object.keys(expectedContext).some((key) => manifest.context[key] !== expectedContext[key])) throw new Error("Restore context mismatch.");
  if (path.resolve(target) === path.resolve(bundle)) throw new Error("Restore target must differ from bundle.");
  for (const entry of manifest.files) {
    const file = inside(target, entry.path, { missing: true });
    if (existsSync(file)) verifyRecord(target, entry);
  }
  let installed = 0;
  for (const entry of manifest.files) {
    if (writeImmutable(target, entry.path, payloads.get(entry.path))) installed += 1;
  }
  return { installed, unchanged: manifest.files.length - installed, manifestSha256 };
}
