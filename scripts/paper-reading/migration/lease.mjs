import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ID, COMMIT, jsonBytes, regularBytes, SHA256 } from "./files.mjs";

export const emptyControl = () => ({ schemaVersion: 1, generation: 0, active: null, checkpoint: null });

function validate(control) {
  if (control?.schemaVersion !== 1 || !Number.isSafeInteger(control.generation) || control.generation < 0) {
    throw new Error("Invalid writer control.");
  }
  if (control.active && (!ID.test(control.active.owner) || !ID.test(control.active.runId) ||
      !ID.test(control.active.token) || !Number.isFinite(Date.parse(control.active.expiresAt)))) {
    throw new Error("Invalid active lease.");
  }
}

export function acquireLease(control, { owner, runId, now, ttlMs = 300_000 }) {
  validate(control);
  if (control.active) throw new Error("A writer is active; expiry alone never permits takeover.");
  if (!ID.test(owner) || !ID.test(runId) || !Number.isFinite(now) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("Invalid lease request.");
  }
  return {
    ...control, generation: control.generation + 1, checkpoint: null,
    active: { owner, runId, token: randomUUID(), expiresAt: new Date(now + ttlMs).toISOString() },
  };
}

export function assertLease(control, lease, now) {
  validate(control);
  if (!control.active || control.generation !== lease.generation ||
      control.active.owner !== lease.active?.owner || control.active.token !== lease.active?.token ||
      control.active.runId !== lease.active?.runId || !Number.isFinite(now) ||
      Date.parse(control.active.expiresAt) <= now) throw new Error("Stale, expired or foreign writer lease.");
}

export function checkpointControl(control, lease, pin, now) {
  assertLease(control, lease, now);
  if (!pin || pin.runId !== control.active.runId || !SHA256.test(pin.sha256) ||
      !Number.isSafeInteger(pin.sequence) || pin.sequence < 0 ||
      (pin.sequence === 0 ? pin.parentSha256 !== null : !SHA256.test(pin.parentSha256))) {
    throw new Error("Invalid checkpoint pin.");
  }
  if (control.checkpoint && pin.sequence <= control.checkpoint.sequence) {
    if (pin.sequence === control.checkpoint.sequence && pin.sha256 === control.checkpoint.sha256) return structuredClone(control);
    throw new Error("Checkpoint cannot move backwards or fork.");
  }
  if (control.checkpoint ? pin.sequence !== control.checkpoint.sequence + 1 ||
      pin.parentSha256 !== control.checkpoint.sha256 : pin.sequence !== 0) {
    throw new Error("Checkpoint chain must advance by one from the acknowledged parent.");
  }
  return { ...control, checkpoint: {
    runId: pin.runId, sha256: pin.sha256, sequence: pin.sequence, parentSha256: pin.parentSha256,
  } };
}

export function renewLease(control, lease, now, ttlMs = 300_000) {
  assertLease(control, lease, now);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("Invalid lease duration.");
  return { ...control, active: { ...control.active, expiresAt: new Date(now + ttlMs).toISOString() } };
}

export function releaseLease(control, lease) {
  validate(control);
  // The current owner can explicitly release after expiry; nobody may steal it.
  if (!control.active || control.generation !== lease.generation ||
      control.active.owner !== lease.active?.owner || control.active.token !== lease.active?.token ||
      control.active.runId !== lease.active?.runId) throw new Error("Cannot release another writer's lease.");
  return { ...control, active: null };
}

const gitEnv = () => ({
  PATH: process.env.PATH, LANG: "C", TMPDIR: process.env.TMPDIR,
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Migration Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Migration Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
});
export function localGit(cwd, args) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never",
    "-c", "protocol.file.allow=always", ...["http", "https", "ssh", "git", "ext"].flatMap((protocol) =>
      ["-c", `protocol.${protocol}.allow=never`]), ...args],
    { cwd, env: gitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// Test/preparation transport only: a filesystem bare repository, never a URL.
// No remote credentials are used and this module cannot push to GitHub.
export function commitControlLocal({ checkout, expectedHead, control }) {
  validate(control);
  if (!COMMIT.test(expectedHead) || localGit(checkout, ["rev-parse", "HEAD"]) !== expectedHead) throw new Error("Checkout HEAD changed.");
  if (localGit(checkout, ["status", "--porcelain"])) throw new Error("Control checkout is dirty.");
  const remote = localGit(checkout, ["config", "--get", "remote.origin.url"]);
  if (!path.isAbsolute(remote) || !existsSync(remote) ||
      localGit(realpathSync(remote), ["rev-parse", "--is-bare-repository"]) !== "true") {
    throw new Error("Only a local filesystem bare remote is permitted.");
  }
  regularBytes(checkout, "control.json");
  writeFileSync(path.join(checkout, "control.json"), jsonBytes(control), { mode: 0o600 });
  localGit(checkout, ["add", "--", "control.json"]);
  localGit(checkout, ["commit", "--no-gpg-sign", "-m", "Update synthetic writer control"]);
  const commit = localGit(checkout, ["rev-parse", "HEAD"]);
  try {
    // Use the validated path directly, so remote.origin.pushurl cannot redirect it.
    localGit(checkout, ["push", realpathSync(remote), "HEAD:refs/heads/main"]);
  } catch {
    const observed = localGit(remote, ["rev-parse", "refs/heads/main"]);
    if (observed !== commit) throw new Error("CAS rejected: another writer advanced the remote. Do not rebase or force-push.");
  }
  const observed = localGit(remote, ["rev-parse", "refs/heads/main"]);
  if (observed !== commit) throw new Error("Control acknowledgement changed; stop before work.");
  return { commit, control };
}
