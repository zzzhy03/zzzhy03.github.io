import { existsSync } from "node:fs";
import path from "node:path";
import { atomicJson } from "./git-store.mjs";
import { COMMIT, SHA256, inside, regularBytes, relativePath, sha256 } from "./files.mjs";
import { artifactRole } from "./state.mjs";

// This is a local cache receipt, not another remote state or locking protocol.
// Its pin must resolve to an ancestor in the same private Git history before it
// can authorize replacing previously acknowledged bytes in a retained checkout.
export function workspaceDirectory(config, root, sessionDirectory) {
  if (config.workspaceDirectory === undefined) return null;
  if (typeof config.workspaceDirectory !== "string" || !path.isAbsolute(config.workspaceDirectory)) {
    throw new Error("A persistent workspace directory must be an explicit absolute path.");
  }
  const directory = path.resolve(config.workspaceDirectory);
  const relative = path.relative(root, directory);
  const inverse = path.relative(directory, root);
  if (directory === sessionDirectory || !relative || !relative.startsWith(`..${path.sep}`) ||
      !inverse.startsWith(`..${path.sep}`)) {
    throw new Error("Workspace metadata must be outside the research checkout and separate from its session directory.");
  }
  inside(directory, "baseline.json", { missing: true });
  return directory;
}

export async function rememberWorkspace(runner) {
  if (!runner.workspaceDirectory || !runner.index) return;
  atomicJson(runner.workspaceDirectory, "baseline.json", {
    schemaVersion: 1, root: runner.root, remote: runner.config.remote, ref: runner.config.ref,
    stateCommit: runner.head, manifestSha256: runner.index.bundle.manifestSha256,
  });
}

export async function priorWorkspace(runner, desiredManifest) {
  const file = runner.workspaceDirectory && path.join(runner.workspaceDirectory, "baseline.json");
  if (!file || !existsSync(file)) return null;
  const baseline = JSON.parse(regularBytes(runner.workspaceDirectory, "baseline.json"));
  if (baseline.schemaVersion !== 1 || baseline.root !== runner.root ||
      baseline.remote !== runner.config.remote || baseline.ref !== runner.config.ref ||
      !COMMIT.test(baseline.stateCommit) || !SHA256.test(baseline.manifestSha256)) {
    throw new Error("Persistent workspace baseline belongs to another checkout/target or is corrupt.");
  }
  try {
    await runner.store.git(runner.store.objects,
      ["merge-base", "--is-ancestor", baseline.stateCommit, runner.head]);
  } catch { throw new Error("Workspace baseline is not verified in the current private history; stop without overwriting data."); }
  const indexBytes = await runner.store.read(baseline.stateCommit, "migration/index.json");
  const index = indexBytes && JSON.parse(indexBytes);
  if (index?.schemaVersion !== 1 || index.bundle?.path !== "migration/bundle" ||
      index.bundle.manifestSha256 !== baseline.manifestSha256) {
    throw new Error("Workspace baseline does not match its acknowledged private index.");
  }
  const bytes = await runner.store.read(baseline.stateCommit, "migration/bundle/manifest.json");
  if (!bytes || sha256(bytes) !== baseline.manifestSha256) throw new Error("Workspace manifest pin mismatch.");
  const manifest = JSON.parse(bytes);
  if (manifest.schemaVersion !== 1 || manifest.kind !== "paper-reading-state-bundle" || !Array.isArray(manifest.files)) {
    throw new Error("Unsupported workspace baseline manifest.");
  }
  const desired = new Set(desiredManifest.files.map((entry) => entry.path));
  const replaceMatching = new Map(), seen = new Set();
  for (const entry of manifest.files) {
    relativePath(entry.path);
    // The current export also supports receipt-pinned withdrawal notices.
    const role = artifactRole(entry.path, new Set([entry.path]));
    if (!role || role !== entry.role || seen.has(entry.path) || !SHA256.test(entry.sha256) ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error("Invalid workspace baseline entry.");
    seen.add(entry.path);
    if (!existsSync(inside(runner.root, entry.path, { missing: true }))) continue;
    if (!desired.has(entry.path)) {
      throw new Error("Remote state removed a retained local artifact; reconcile explicitly instead of deleting or resurrecting it.");
    }
    const current = regularBytes(runner.root, entry.path);
    if (current.length === entry.bytes && sha256(current) === entry.sha256) replaceMatching.set(entry.path, current);
  }
  return replaceMatching;
}
