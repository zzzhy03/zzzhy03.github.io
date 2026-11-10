import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, lstatSync, readFileSync, readdirSync, mkdirSync,
  writeFileSync, linkSync, unlinkSync,
} from "node:fs";
import path from "node:path";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export const SHA256 = /^[a-f0-9]{64}$/;
export const COMMIT = /^[a-f0-9]{40,64}$/;
export const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

export function relativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") ||
      /[\x00-\x1f\x7f]/.test(value) || path.posix.isAbsolute(value) ||
      value.split("/").some((part) => !part || part === "." || part === ".." || part === ".git") ||
      /^[a-zA-Z]:/.test(value)) throw new Error("Unsafe relative path.");
  return value;
}

// Reject symlinks in every existing ancestor, including the root itself.
// Callers must use an exclusively owned staging/checkout directory.
export function inside(root, relative, { missing = false } = {}) {
  relativePath(relative);
  root = path.resolve(root);
  const target = path.join(root, relative);
  let cursor = path.parse(target).root;
  for (const part of target.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, part);
    if (!existsSync(cursor)) {
      // existsSync is false for a dangling link too.
      try {
        if (lstatSync(cursor).isSymbolicLink()) throw new Error("Symlink rejected.");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (!missing) throw new Error(`Missing artifact: ${relative}`);
      continue;
    }
    if (lstatSync(cursor).isSymbolicLink()) throw new Error("Symlink rejected.");
  }
  return target;
}

export function regularBytes(root, relative) {
  const file = inside(root, relative);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 100 * 1024 * 1024) {
    throw new Error("Artifact must be a regular file smaller than 100 MiB.");
  }
  const bytes = readFileSync(file);
  if (bytes.length !== stat.size) throw new Error("Artifact changed while reading.");
  return bytes;
}

export function record(root, relative) {
  const bytes = regularBytes(root, relative);
  return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
}

export function verifyRecord(root, entry) {
  if (!entry || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
      !SHA256.test(entry.sha256)) throw new Error("Invalid artifact record.");
  const bytes = regularBytes(root, entry.path);
  if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
    throw new Error(`Artifact hash/length mismatch: ${entry.path}`);
  }
  return bytes;
}

export function walk(root, relative) {
  const directory = inside(root, relative, { missing: true });
  if (!existsSync(directory)) return [];
  if (!lstatSync(directory).isDirectory()) throw new Error("Expected a directory.");
  const files = [];
  for (const child of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const next = `${relative}/${child.name}`;
    if (child.isSymbolicLink()) {
      files.push({ path: next, type: "symlink", bytes: 0 });
    } else if (child.isDirectory()) {
      files.push(...walk(root, next));
    } else if (child.isFile()) {
      files.push({ path: next, type: "file", bytes: lstatSync(path.join(root, next)).size });
    } else {
      files.push({ path: next, type: "special", bytes: 0 });
    }
  }
  return files;
}

// Only selected data artifacts are examined. Never read auth stores or environment files.
// These checks are a preflight aid, not a guarantee that arbitrary prose contains no secrets.
export function assertNoCredentials(bytes, { json = false } = {}) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes) || text.includes("\0") ||
      /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?<![A-Za-z0-9_-])(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}|(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._~+/-]{16,}/.test(text)) {
    throw new Error("Sensitive or non-text content rejected; values suppressed.");
  }
  for (const match of text.matchAll(/https?:\/\/[^\s"<>]+/g)) {
    let url;
    try { url = new URL(match[0]); } catch { continue; }
    if (url.username || url.password || [...url.searchParams.keys()].some((key) =>
      /^(access_token|refresh_token|api_key|apikey|client_secret|signature|x-amz-signature)$/i.test(key))) {
      throw new Error("Credential-bearing URL rejected; values suppressed.");
    }
  }
  if (json) {
    const inspect = (value) => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (/^(authorization|proxyAuthorization|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|password|passwd|cookie|cookies|private[_-]?key)$/i.test(key)) {
          throw new Error("Credential-shaped field rejected; values suppressed.");
        }
        inspect(child);
      }
    };
    inspect(JSON.parse(text));
  }
}

export function writeImmutable(root, relative, bytes) {
  const target = inside(root, relative, { missing: true });
  if (existsSync(target)) {
    if (!regularBytes(root, relative).equals(bytes)) throw new Error(`Immutable file conflict: ${relative}`);
    return false;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  inside(root, relative, { missing: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
  try {
    // Atomic no-overwrite installation; an interrupted call can be replayed.
    linkSync(temp, target);
  } finally {
    unlinkSync(temp);
  }
  return true;
}
