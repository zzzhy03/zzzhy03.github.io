import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import path from "node:path";
import { COMMIT, inside, jsonBytes, regularBytes, relativePath, walk } from "./files.mjs";

export function gitFailureDetails({ code, signal, timedOut, outputLimit, stderr = "" }) {
  const match = stderr.match(/(?:HTTP(?:\/[\d.]+)?(?: code)?[ :]+|requested URL returned error: )([45]\d{2})\b/i);
  const httpStatus = match ? Number(match[1]) : null;
  let category = "unclassified";
  if (outputLimit) category = "output-limit";
  else if (timedOut) category = "timeout";
  else if (httpStatus === 401 || httpStatus === 403 || /authentication failed|permission denied|access denied/i.test(stderr)) category = "access-denied";
  else if (httpStatus === 429) category = "rate-limited";
  else if (httpStatus >= 500) category = "http-unavailable";
  else if (httpStatus) category = "http-error";
  else if (/could not resolve|unable to resolve/i.test(stderr)) category = "dns";
  else if (/non-fast-forward|fetch first|cannot lock ref.*expected/i.test(stderr)) category = "ref-conflict";
  else if (/connection reset|failed to connect|connection timed out/i.test(stderr)) category = "connection";
  return { exitCode: Number.isInteger(code) ? code : null, signal: signal ?? null,
    timedOut: Boolean(timedOut), httpStatus, category };
}

// Inherit the already authorized credential helper and proxy. Never log Git's
// stderr: helpers may include credentials or private URLs in diagnostics.
export function git(cwd, args, { env = {}, input, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [
      "-c", `core.hooksPath=${devNull}`, "-c", "protocol.allow=never",
      "-c", "protocol.https.allow=always", "-c", "protocol.file.allow=always",
      "-c", "credential.interactive=false", "-c", "core.autocrlf=false",
      "-c", "commit.gpgsign=false", ...args,
    ], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never",
      GIT_AUTHOR_NAME: "Paper Reading Runner", GIT_AUTHOR_EMAIL: "runner@example.invalid",
      GIT_COMMITTER_NAME: "Paper Reading Runner", GIT_COMMITTER_EMAIL: "runner@example.invalid",
      ...env }, stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let size = 0, stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      // Retain only a bounded in-memory diagnostic for classification, never
      // the raw text in an error, log, journal or tool result.
      if (stderr.length < 65_536) stderr += chunk.toString().slice(0, 65_536 - stderr.length);
    });
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 256 * 1024 * 1024) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.stdin.on("error", () => {});
    child.once("error", () => { clearTimeout(timer); reject(new Error("Git could not start.")); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && size <= 256 * 1024 * 1024) resolve(Buffer.concat(chunks));
      else {
        const details = gitFailureDetails({ code, signal, timedOut, outputLimit: size > 256 * 1024 * 1024, stderr });
        const action = /^[a-z][a-z-]*$/.test(args[0]) ? args[0] : "operation";
        reject(Object.assign(new Error(`Git ${action} failed (${details.category}${details.httpStatus ? `, HTTP ${details.httpStatus}` : ""}); raw diagnostics suppressed.`), details));
      }
    });
    child.stdin.end(input);
  });
}

export function validateRemote(remote, ref) {
  if (typeof remote !== "string" || !remote || /[\0\r\n]/.test(remote)) throw new Error("Invalid remote.");
  if (!path.isAbsolute(remote)) {
    let url;
    try { url = new URL(remote); } catch { throw new Error("Use an explicit GitHub HTTPS remote or local bare repository."); }
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port ||
        url.username || url.password || url.search || url.hash ||
        !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(url.pathname)) {
      throw new Error("Use a credential-free GitHub HTTPS repository URL.");
    }
  }
  if (typeof ref !== "string" || !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(ref) ||
      ref.includes("..") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".") ||
      ref.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))) {
    throw new Error("An explicit branch ref is required.");
  }
}

export function atomicJson(directory, file, value) {
  const target = inside(directory, file, { missing: true });
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, jsonBytes(value), { flag: "wx", mode: 0o600 });
  renameSync(temporary, target);
}

export class PushOutcomeError extends Error {
  constructor(outcome, commit) {
    super(`Push outcome: ${outcome}. Stop work and run recover; the proposal and research files are retained.`);
    this.outcome = outcome;
    this.commit = commit;
  }
}

// The bare object cache and disposable indexes never use the research checkout's
// index or working tree. A failed staging operation needs no reset or clean.
export class GitStore {
  constructor({ remote, ref, directory, runGit = git }) {
    validateRemote(remote, ref);
    this.remote = remote;
    this.ref = ref;
    this.directory = path.resolve(directory);
    this.objects = path.join(this.directory, "objects.git");
    this.git = runGit;
  }

  async init() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    inside(this.directory, "objects.git", { missing: true });
    if (!existsSync(this.objects)) await this.git(this.directory, ["init", "--bare", this.objects]);
    if ((await this.git(this.objects, ["rev-parse", "--is-bare-repository"])).toString().trim() !== "true") {
      throw new Error("State cache must be a bare repository.");
    }
    // Refuse URL rewriting rather than silently contacting a different remote.
    const resolved = (await this.git(this.objects, ["ls-remote", "--get-url", this.remote])).toString().trim();
    if (resolved !== this.remote) throw new Error("Remote URL rewriting is not supported.");
    const configuration = (await this.git(this.objects, ["config", "--null", "--list"])).toString();
    for (const entry of configuration.split("\0")) {
      const newline = entry.indexOf("\n");
      if (/^url\..*\.pushinsteadof$/i.test(entry.slice(0, newline)) &&
          this.remote.startsWith(entry.slice(newline + 1))) throw new Error("Push URL rewriting is not supported.");
    }
    if (path.isAbsolute(this.remote) &&
        (await this.git(this.remote, ["rev-parse", "--is-bare-repository"])).toString().trim() !== "true") {
      throw new Error("Local test remote must be bare.");
    }
    return this;
  }

  async head() {
    const rows = (await this.git(this.objects, ["ls-remote", "--exit-code", this.remote, this.ref]))
      .toString().trim().split("\n");
    const fields = rows[0]?.split(/\s+/);
    if (rows.length !== 1 || !COMMIT.test(fields[0]) || fields[1] !== this.ref) {
      throw new Error("The explicitly selected remote branch must already exist.");
    }
    return fields[0];
  }

  async fetchHead() {
    const head = await this.head();
    await this.git(this.objects, ["fetch", "--no-tags", this.remote, this.ref]);
    const fetched = (await this.git(this.objects, ["rev-parse", "FETCH_HEAD"])).toString().trim();
    if (fetched !== head) throw new Error("Remote changed during fetch; stop and reopen.");
    return head;
  }

  async read(commit, file) {
    if (!COMMIT.test(commit)) throw new Error("Exact commit required.");
    relativePath(file);
    const entry = await this.git(this.objects, ["ls-tree", "-z", commit, "--", file]);
    if (!entry.length) return null;
    if (!entry.toString().startsWith("100644 blob ") && !entry.toString().startsWith("100755 blob ")) {
      throw new Error("State entry must be a regular file.");
    }
    return this.git(this.objects, ["show", `${commit}:${file}`]);
  }

  pending() {
    if (!existsSync(path.join(this.directory, "pending.json"))) return null;
    const proposal = JSON.parse(regularBytes(this.directory, "pending.json"));
    if (proposal.remote !== this.remote || proposal.ref !== this.ref ||
        !COMMIT.test(proposal.expectedHead) || !COMMIT.test(proposal.commit)) {
      throw new Error("Pending proposal belongs to another target or is corrupt.");
    }
    return proposal;
  }

  async prepare(expectedHead, populate) {
    if (this.pending()) throw new Error("Recover the pending push before preparing another state change.");
    if (!COMMIT.test(expectedHead) || await this.head() !== expectedHead) throw new Error("State HEAD changed; do not rebase or force-push.");
    const proposalId = randomUUID();
    const directory = inside(this.directory, `proposals/${proposalId}`, { missing: true });
    const payload = path.join(directory, "payload");
    mkdirSync(payload, { recursive: true, mode: 0o700 });
    const env = { GIT_INDEX_FILE: path.join(directory, "index") };
    await this.git(this.objects, ["read-tree", expectedHead], { env });
    const paths = await populate(payload);
    if (!Array.isArray(paths) || !paths.length) throw new Error("No state changes supplied.");
    for (const file of paths) {
      relativePath(file);
      if (!file.startsWith("migration/")) throw new Error("Only migration state paths may be staged.");
    }
    await this.git(this.objects, ["--work-tree", payload, "add", "-A", "--", ...paths], { env });
    const staged = new Map((await this.git(this.objects, ["ls-files", "--stage", "-z"], { env }))
      .toString().split("\0").filter(Boolean).map((entry) => {
        const [metadata, file] = entry.split("\t");
        return [file, metadata.split(" ")[1]];
      }));
    for (const file of walk(payload, "migration")) {
      const bytes = regularBytes(payload, file.path);
      const blob = createHash(expectedHead.length === 40 ? "sha1" : "sha256")
        .update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (staged.get(file.path) !== blob) throw new Error("Git staging changed artifact bytes; inspect attributes/filters. Nothing was pushed.");
    }
    const tree = (await this.git(this.objects, ["write-tree"], { env })).toString().trim();
    const commit = (await this.git(this.objects, ["commit-tree", tree, "-p", expectedHead, "-m", "Persist paper-reading progress"])).toString().trim();
    await this.git(this.objects, ["update-ref", `refs/migration-proposals/${proposalId}`, commit]);
    const proposal = { remote: this.remote, ref: this.ref, expectedHead, commit, proposalId };
    // Written before any push. Retained even if the process loses the push reply.
    atomicJson(this.directory, "pending.json", proposal);
    return proposal;
  }

  async recover({ retry = false } = {}) {
    const proposal = this.pending();
    if (!proposal) return { outcome: "none" };
    let observed;
    try { observed = await this.head(); } catch { throw new PushOutcomeError("unknown", proposal.commit); }
    if (observed === proposal.expectedHead && retry) {
      try {
        // An explicit URL/path and exact commit avoid origin.pushurl and mutable HEAD.
        await this.git(this.objects, ["push", this.remote, `${proposal.commit}:${this.ref}`]);
      } catch { /* A failed reply does not establish whether GitHub accepted it. */ }
      try { observed = await this.head(); } catch { throw new PushOutcomeError("unknown", proposal.commit); }
    }
    if (observed !== proposal.commit) {
      throw new PushOutcomeError(observed === proposal.expectedHead ? "not-applied" : "conflict", proposal.commit);
    }
    unlinkSync(path.join(this.directory, "pending.json"));
    return { outcome: "acknowledged", commit: proposal.commit };
  }

  async materialize(commit) {
    if (!COMMIT.test(commit)) throw new Error("Exact commit required.");
    const directory = inside(this.directory, `views/${randomUUID()}`, { missing: true });
    const target = path.join(directory, "files");
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const env = { GIT_INDEX_FILE: path.join(directory, "index") };
    await this.git(this.objects, ["read-tree", commit], { env });
    await this.git(this.objects, ["--work-tree", target, "checkout-index", "--all", `--prefix=${target}${path.sep}`], { env });
    return target;
  }
}
