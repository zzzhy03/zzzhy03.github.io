import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GitStore, atomicJson, git } from "./git-store.mjs";
import { ID, inside, jsonBytes, record, regularBytes, relativePath, sha256, verifyRecord } from "./files.mjs";
import { exportState, restoreState, verifyBundle } from "./state.mjs";
import { acquireLease, assertLease, checkpointControl, emptyControl, releaseLease, renewLease } from "./lease.mjs";
import { beginUnit, completeUnit, newCheckpoint, resumePlan, saveCheckpoint } from "./checkpoints.mjs";

const CONTROL = "migration/control.json";
const INDEX = "migration/index.json";
const bundleContext = (context) => ({
  repositoryBaseCommit: context.repositoryBaseCommit, codeSnapshotSha256: context.codeSnapshotSha256,
});
const same = (a, b) => sha256(jsonBytes(a)) === sha256(jsonBytes(b));

function jobRequest(job) {
  if (!job || !Array.isArray(job.inputs) || !Array.isArray(job.outputs) || !job.outputs.length ||
      new Set(job.outputs).size !== job.outputs.length ||
      !Array.isArray(job.validate) || !job.validate.length ||
      [job.command, job.validate].filter(Boolean).some((argv) => !Array.isArray(argv) || !argv.length ||
        argv.some((arg) => typeof arg !== "string" || !arg || arg.includes("\0")))) {
    throw new Error("A unit requires input records, output paths and a validation argv.");
  }
  job.outputs.forEach(relativePath);
  // Only the digest is durable; commands/absolute machine paths are not state.
  return { id: job.id, stage: job.stage, dependencies: job.dependencies ?? [],
    inputSha256: sha256(jsonBytes({ inputs: job.inputs, outputs: job.outputs,
      command: job.command ?? null, validate: job.validate })) };
}

export class Runner {
  constructor(config, { runGit = git, now = Date.now } = {}) {
    config = { ...config, context: newCheckpoint(config.context).context };
    if (!ID.test(config.owner)) throw new Error("An explicit owner is required.");
    this.config = config;
    this.root = path.resolve(config.root);
    this.directory = path.resolve(config.directory);
    const relative = path.relative(this.root, this.directory);
    const inverse = path.relative(this.directory, this.root);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== "..") ||
        (!inverse.startsWith(`..${path.sep}`) && inverse !== "..")) {
      throw new Error("Research root and runner state directory must be separate.");
    }
    inside(this.root, "content", { missing: true });
    inside(this.directory, "session.json", { missing: true });
    this.now = now;
    this.ttlMs = config.ttlMs ?? 300_000;
    this.heartbeatMs = config.heartbeatMs ?? Math.floor(this.ttlMs / 3);
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 30_000 ||
        !Number.isSafeInteger(this.heartbeatMs) || this.heartbeatMs < 20 || this.heartbeatMs > this.ttlMs / 3) {
      throw new Error("Lease must last at least 30 seconds; renew at least three times per lease.");
    }
    this.store = new GitStore({ remote: config.remote, ref: config.ref,
      directory: path.join(this.directory, "transport"), runGit });
  }

  async open() {
    await this.store.init();
    if (this.store.pending()) throw new Error("Pending state push; run recover before any work.");
    await this.load();
    return this;
  }

  async load() {
    const head = await this.store.fetchHead();
    const controlBytes = await this.store.read(head, CONTROL);
    const indexBytes = await this.store.read(head, INDEX);
    if (Boolean(controlBytes) !== Boolean(indexBytes)) throw new Error("Incomplete durable state index.");
    const control = controlBytes ? JSON.parse(controlBytes) : null;
    const index = indexBytes ? JSON.parse(indexBytes) : null;
    let checkpoint = null;
    if (index) {
      if (index.schemaVersion !== 1 || index.bundle?.path !== "migration/bundle") throw new Error("Unsupported durable state index.");
      const pin = index.checkpoint;
      const bytes = await this.store.read(head, `migration/checkpoints/${relativePath(pin.path)}`);
      if (!bytes || bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256 ||
          control.checkpoint?.sha256 !== pin.sha256) throw new Error("Durable checkpoint pin mismatch.");
      checkpoint = JSON.parse(bytes);
      newCheckpoint(checkpoint.context);
      if (checkpoint.sequence !== control.checkpoint.sequence) throw new Error("Durable checkpoint sequence mismatch.");
    }
    const session = existsSync(path.join(this.directory, "session.json"))
      ? JSON.parse(regularBytes(this.directory, "session.json")) : null;
    if (session && (session.remote !== this.config.remote || session.ref !== this.config.ref ||
        !same(session.context, this.config.context) || session.lease.active.owner !== this.config.owner)) {
      throw new Error("Local session belongs to another owner, run or target.");
    }
    // A heartbeat may finish while the command proceeds to validation. Expose
    // only a complete snapshot, never a partially refreshed control/checkpoint.
    Object.assign(this, { head, control, index, checkpoint, session });
    return this;
  }

  owned() {
    if (!this.session || !this.control || !this.checkpoint || !same(this.checkpoint.context, this.config.context) ||
        this.control.active?.runId !== this.config.context.runId) {
      throw new Error("Start this run or restore its original owner session before writing.");
    }
    assertLease(this.control, this.session.lease, this.now());
  }

  async current() {
    this.owned();
    if (await this.store.head() !== this.head) throw new Error("State HEAD changed; stop and reopen.");
    this.owned();
  }

  async verifySource() {
    const base = this.config.context.repositoryBaseCommit;
    const snapshot = await this.store.git(this.root, ["archive", "--format=tar", base]);
    if (sha256(snapshot) !== this.config.context.codeSnapshotSha256) throw new Error("Reviewed source snapshot mismatch.");
    // Data edits are expected. Executable/source edits require a new reviewed run.
    const changed = (await this.store.git(this.root, ["diff", "--name-only", base, "--", ".",
      ":(exclude)content/paper-reading/**"])).toString().trim();
    if (changed) throw new Error("Tracked source changed outside paper-reading data.");
  }

  async start() {
    if (this.session && this.control?.active) {
      this.owned();
      return this.status();
    }
    await this.verifySource();
    if (!this.index) {
      if (this.config.initializeFromRoot !== true || this.config.expectedStateCommit !== this.head) {
        throw new Error("Initialization requires reviewed local state and its exact expected remote commit.");
      }
    } else {
      if (this.control.active) throw new Error("A writer is active; expiry does not authorize takeover.");
      if (this.checkpoint.context.runId === this.config.context.runId) throw new Error("This released run already exists; start a new run ID.");
      await this.restore();
    }
    const lease = acquireLease(this.control ?? emptyControl(), {
      owner: this.config.owner, runId: this.config.context.runId, now: this.now(), ttlMs: this.ttlMs,
    });
    this.session = { remote: this.config.remote, ref: this.config.ref, context: this.config.context, lease };
    atomicJson(this.directory, "session.json", this.session);
    await this.persist({ control: lease, checkpoint: newCheckpoint(this.config.context), exportBundle: true, publication: null });
    return this.status();
  }

  async persist({ control = this.control, checkpoint = this.checkpoint, exportBundle = false,
    publication = this.index?.publication ?? null } = {}) {
    const expectedHead = this.head;
    const index = structuredClone(this.index ?? { schemaVersion: 1 });
    await this.store.prepare(expectedHead, (payload) => {
      const paths = [CONTROL, INDEX];
      if (exportBundle) {
        const pin = exportState({ root: this.root, destination: path.join(payload, "migration/bundle"),
          context: bundleContext(checkpoint.context) });
        const { manifest } = verifyBundle({ bundle: path.join(payload, "migration/bundle"), manifestSha256: pin.manifestSha256 });
        const records = new Map(manifest.files.map((file) => [file.path, file]));
        for (const unit of Object.values(checkpoint.units)) {
          for (const output of unit.outputs ?? []) {
            const entry = records.get(output.path);
            if (!entry || entry.sha256 !== output.sha256 || entry.bytes !== output.bytes) {
              throw new Error("Every completed output must be included in the durable state bundle.");
            }
          }
        }
        index.bundle = { path: "migration/bundle", manifestSha256: pin.manifestSha256 };
        paths.push("migration/bundle");
      }
      const pin = saveCheckpoint(path.join(payload, "migration/checkpoints"), checkpoint);
      control = checkpointControl(control, this.session.lease, { ...pin,
        runId: checkpoint.context.runId, sequence: checkpoint.sequence, parentSha256: checkpoint.parentSha256 }, this.now());
      index.checkpoint = pin;
      index.publication = publication;
      atomicJson(payload, CONTROL, control);
      atomicJson(payload, INDEX, index);
      paths.push(`migration/checkpoints/${pin.path}`);
      return paths;
    });
    // This acknowledgement, not the local commit or push exit code, gates work.
    await this.store.recover({ retry: true });
    await this.load();
    this.owned();
  }

  async recover({ retry = false } = {}) {
    await this.store.init();
    const result = await this.store.recover({ retry });
    await this.load();
    return { ...result, ...this.status() };
  }

  async restore() {
    if (!this.index) throw new Error("No durable bundle to restore.");
    const view = await this.store.materialize(this.head);
    const bundle = path.join(view, this.index.bundle.path);
    const { manifest } = verifyBundle({ bundle, manifestSha256: this.index.bundle.manifestSha256 });
    return restoreState({ bundle, target: this.root, manifestSha256: this.index.bundle.manifestSha256,
      expectedContext: manifest.context });
  }

  status() {
    if (!this.checkpoint) return { stateCommit: this.head, initialized: false };
    return { stateCommit: this.head, initialized: true, runId: this.checkpoint.context.runId,
      sequence: this.checkpoint.sequence, leaseExpiresAt: this.control.active?.expiresAt ?? null,
      ...resumePlan(this.checkpoint, this.root, this.checkpoint.context), publication: this.index.publication };
  }

  async renew() {
    await this.current();
    await this.persist({ control: renewLease(this.control, this.session.lease, this.now(), this.ttlMs) });
    return { stateCommit: this.head, leaseExpiresAt: this.control.active.expiresAt };
  }

  async resume() {
    // Explicit same-owner recovery, including expiry. The CLI session lock must
    // be clear; an abandoned lock requires verified dead-PID unlock first.
    if (!this.session || !this.checkpoint || !same(this.checkpoint.context, this.config.context)) {
      throw new Error("Original owner session and frozen context required.");
    }
    if (await this.store.head() !== this.head) throw new Error("State HEAD changed.");
    const previous = this.session;
    const released = releaseLease(this.control, previous.lease);
    const lease = { ...acquireLease(released, { owner: this.config.owner, runId: this.config.context.runId,
      now: this.now(), ttlMs: this.ttlMs }), checkpoint: this.control.checkpoint };
    this.session = { ...previous, lease };
    atomicJson(this.directory, "session.json", this.session);
    try { await this.persist({ control: lease }); }
    catch (error) {
      if (!this.store.pending()) {
        this.session = previous;
        atomicJson(this.directory, "session.json", previous);
      }
      throw error;
    }
    return this.status();
  }

  async begin(job) {
    const request = jobRequest(job);
    await this.current();
    await this.verifySource();
    if (this.index.publication) throw new Error("Resume publication; no additional research units may start.");
    for (const input of job.inputs) verifyRecord(this.root, input);
    resumePlan(this.checkpoint, this.root, this.config.context);
    const checkpoint = beginUnit(this.checkpoint, request);
    const existing = this.checkpoint.units[job.id];
    if (existing?.state === "complete") return { skipped: true, unit: job.id };
    if (existing) throw new Error("Uncertain intent: inspect outputs and explicitly reconcile; never automatically rerun.");
    await this.persist({ control: renewLease(this.control, this.session.lease, this.now(), this.ttlMs),
      checkpoint, exportBundle: true });
    return { begun: true, unit: job.id, stateCommit: this.head };
  }

  async commands(argvs) {
    await this.renew();
    let failure = null, flight = null, child = null, deadline = null;
    const stopChild = () => {
      if (!child?.pid) return;
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch { /* Already exited. */ }
    };
    const armDeadline = () => {
      clearTimeout(deadline);
      deadline = setTimeout(() => {
        failure = new Error("Lease expired during execution; intent remains uncertain.");
        stopChild();
      }, Math.max(0, Date.parse(this.control.active.expiresAt) - this.now()));
    };
    const interrupt = () => { failure = new Error("Execution interrupted; reconcile its durable intent."); stopChild(); };
    process.once("SIGTERM", interrupt);
    process.once("SIGINT", interrupt);
    armDeadline();
    const timer = setInterval(() => {
      if (flight || failure) return;
      flight = this.renew().then(armDeadline).catch((error) => {
        failure = error; stopChild();
      }).finally(() => { flight = null; });
    }, this.heartbeatMs);
    try {
      for (const argv of argvs) {
        await flight;
        if (failure) throw failure;
        this.owned();
        await new Promise((resolve, reject) => {
          child = spawn(argv[0], argv.slice(1), { cwd: this.root, env: process.env,
            detached: process.platform !== "win32", stdio: ["ignore", "inherit", "inherit"] });
          child.once("error", () => reject(new Error("Unit command could not start; reconcile its intent.")));
          child.once("close", (code) => code === 0 ? resolve() : reject(new Error("Unit command failed; reconcile its intent.")));
        });
        child = null;
      }
    } finally {
      clearInterval(timer);
      await flight;
      clearTimeout(deadline);
      process.removeListener("SIGTERM", interrupt);
      process.removeListener("SIGINT", interrupt);
      stopChild();
    }
    if (failure) throw failure;
    await this.current();
    await this.verifySource();
  }

  async run(job) {
    if (!job.command) throw new Error("run requires a command argv; use begin for task-authored analysis.");
    const started = await this.begin(job);
    if (started.skipped) return started;
    await this.commands([job.command, job.validate]);
    return this.finish(job);
  }

  async reconcile(job) {
    const request = jobRequest(job);
    await this.current();
    await this.verifySource();
    if (!this.checkpoint.units[job.id]) throw new Error("No durable intent to reconcile.");
    beginUnit(this.checkpoint, request); // Reject a changed command/input/output contract.
    if (this.checkpoint.units[job.id].state === "complete") return this.status();
    // Explicit recovery validates existing files; it does not invoke job.command.
    await this.commands([job.validate]);
    return this.finish(job);
  }

  async finish(job) {
    await this.current();
    const checkpoint = completeUnit(this.checkpoint, { id: job.id, root: this.root,
      outputs: job.outputs.map((file) => record(this.root, file)) });
    await this.persist({ checkpoint, exportBundle: true });
    return { completed: job.id, stateCommit: this.head, sequence: this.checkpoint.sequence };
  }

  async journal(publication) {
    await this.current();
    await this.persist({ publication });
  }

  async release() {
    if (!this.session || !this.control) throw new Error("Original owner session required.");
    if (Object.values(this.checkpoint.units).some((unit) => unit.state === "intent") ||
        (this.index.publication && this.index.publication.events.at(-1)?.type !== "verified")) {
      throw new Error("Reconcile unfinished intent/publication before releasing the run.");
    }
    if (await this.store.head() !== this.head) throw new Error("State HEAD changed.");
    const control = releaseLease(this.control, this.session.lease);
    await this.store.prepare(this.head, (payload) => {
      atomicJson(payload, CONTROL, control);
      return [CONTROL];
    });
    await this.store.recover({ retry: true });
    await this.load();
    return { released: true, stateCommit: this.head };
  }
}

// A second CLI cannot race the heartbeat in the same local session directory.
// A killed CLI leaves the lock for an explicit, same-host dead-PID recovery.
export async function withSessionLock(directory, action, { unlock = false } = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = inside(directory, "runner.lock", { missing: true });
  if (unlock) {
    const lock = JSON.parse(regularBytes(directory, "runner.lock"));
    if (lock.host !== hostname() || !Number.isSafeInteger(lock.pid) || lock.pid <= 0) throw new Error("Cannot verify the previous process on this host.");
    try { process.kill(lock.pid, 0); } catch (error) {
      if (error.code === "ESRCH") { unlinkSync(file); return { unlocked: true }; }
      throw new Error("Previous process status is uncertain; lock retained.");
    }
    throw new Error("Previous process still exists; lock retained.");
  }
  try { writeFileSync(file, jsonBytes({ host: hostname(), pid: process.pid }), { flag: "wx", mode: 0o600 }); }
  catch { throw new Error("Session is locked; stop its owner or use unlock after that process exits."); }
  try { return await action(); } finally { unlinkSync(file); }
}

export async function main(argv) {
  const [command, configFile, jobFile] = argv;
  if (!["start", "status", "restore", "renew", "resume", "begin", "run", "reconcile", "recover", "retry", "release", "unlock", "publish"].includes(command) ||
      !configFile || argv.length > 3) throw new Error("Usage: runner.mjs COMMAND LOCAL_CONFIG.json [LOCAL_JOB.json]");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  return withSessionLock(path.resolve(config.directory), async () => {
    const runner = new Runner(config);
    if (command === "recover" || command === "retry") return runner.recover({ retry: command === "retry" });
    await runner.open();
    if (["begin", "run", "reconcile", "publish"].includes(command)) {
      if (!jobFile) throw new Error("A local job specification is required.");
      const job = JSON.parse(readFileSync(jobFile, "utf8"));
      if (command === "publish") {
        const { publish } = await import("./publication.mjs");
        return publish(runner, job);
      }
      return runner[command](job);
    }
    if (jobFile) throw new Error("This command takes no job specification.");
    return runner[command]();
  }, { unlock: command === "unlock" });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
