import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GitStore, atomicJson, git } from "./git-store.mjs";
import { assertNoCredentials, COMMIT, ID, inside, jsonBytes, record, regularBytes, relativePath, sha256, verifyRecord, writeImmutable } from "./files.mjs";
import { exportState, restoreState, verifyBundle } from "./state.mjs";
import { acquireLease, assertLease, checkpointControl, emptyControl, releaseLease, renewLease } from "./lease.mjs";
import { beginUnit, completeUnit, newCheckpoint, resumePlan, saveCheckpoint } from "./checkpoints.mjs";
import { commandArgv, jobRequest, portableJob } from "./contracts.mjs";
import { priorWorkspace, rememberWorkspace, workspaceDirectory } from "./workspace.mjs";
import { validateRemote } from "./git-store.mjs";

const CONTROL = "migration/control.json";
const INDEX = "migration/index.json";
const bundleContext = (context) => ({
  repositoryBaseCommit: context.repositoryBaseCommit, codeSnapshotSha256: context.codeSnapshotSha256,
});
const same = (a, b) => sha256(jsonBytes(a)) === sha256(jsonBytes(b));

function confirmationRecord(value, now) {
  if (!value || !ID.test(value.confirmedBy) || typeof value.reason !== "string" ||
      !value.reason.trim() || value.reason.length > 2000) {
    throw new Error("An explicit confirmation identity and reason are required.");
  }
  const result = { confirmedBy: value.confirmedBy, reason: value.reason, at: new Date(now).toISOString() };
  assertNoCredentials(jsonBytes(result), { json: true });
  return result;
}

function endedConfirmation(value, control, head, now) {
  if (value?.previousInstanceEnded !== true || value.expectedStateCommit !== head ||
      value.previousOwner !== control.active?.owner || value.previousRunId !== control.active?.runId ||
      value.previousGeneration !== control.generation) {
    throw new Error("Confirm the exact previous instance ended, with its state commit, owner, run and generation.");
  }
  return { ...confirmationRecord(value, now), previousStateCommit: head,
    previousOwner: control.active.owner, previousRunId: control.active.runId, previousGeneration: control.generation };
}

export class Runner {
  constructor(config, { runGit = git, now = Date.now } = {}) {
    config = { ...config, ...(config.context ? { context: newCheckpoint(config.context).context } : {}) };
    if (!ID.test(config.owner)) throw new Error("An explicit owner is required.");
    this.config = config;
    this.root = path.resolve(config.root);
    this.directory = path.resolve(config.directory);
    this.workspaceDirectory = workspaceDirectory(config, this.root, this.directory);
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

  async load(acknowledgedCommit = null) {
    if (acknowledgedCommit !== null && !COMMIT.test(acknowledgedCommit)) throw new Error("Exact acknowledged commit required.");
    // A successful recover() already read the exact remote HEAD. Its objects
    // were created locally; fetching them again adds a needless failure point.
    // Fresh sessions still fetch, and current() fences every subsequent action.
    const head = acknowledgedCommit ?? await this.store.fetchHead();
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
      // A new machine can discover the frozen run without any former local file.
      this.config.context ??= checkpoint.context;
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

  async prepareWorkspaceSource() {
    if (!this.workspaceDirectory) return;
    if ((await this.store.git(this.root, ["diff", "--cached", "--name-only"])).length) {
      throw new Error("Staged user changes are present; the persistent workspace is unchanged.");
    }
    if (this.config.source) {
      validateRemote(this.config.source.remote, this.config.source.ref);
      // Fetch objects only: keep the user's branch, HEAD, index and working tree.
      await this.store.git(this.root, ["fetch", "--no-tags", this.config.source.remote, this.config.source.ref]);
    }
    await this.verifySource();
  }

  async start() {
    if (this.session && this.control?.active) {
      this.owned();
      return this.status();
    }
    if (!this.config.context) throw new Error("A frozen context is required to start a new run.");
    if (this.workspaceDirectory && this.control?.active) {
      throw new Error("A writer is active; a retained local checkout never authorizes takeover, even after expiry.");
    }
    await this.prepareWorkspaceSource();
    await this.verifySource();
    if (!this.index) {
      if (this.config.initializeFromRoot !== true || this.config.expectedStateCommit !== this.head) {
        throw new Error("Initialization requires reviewed local state and its exact expected remote commit.");
      }
    } else {
      if (this.control.active) throw new Error("A writer is active; expiry does not authorize takeover.");
      if (this.checkpoint.context.runId === this.config.context.runId) throw new Error("This released run already exists; start a new run ID.");
      await this.restore({ freshCheckout: !this.session });
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
    publication = this.index?.publication ?? null, contract = null, artifacts = [], recomputation = null } = {}) {
    const expectedHead = this.head;
    const index = structuredClone(this.index ?? { schemaVersion: 1 });
    if (checkpoint.context.runId !== this.checkpoint?.context.runId) {
      index.contracts = {};
      delete index.recomputations;
    }
    await this.store.prepare(expectedHead, (payload) => {
      const paths = [CONTROL, INDEX];
      if (contract) {
        const bytes = jsonBytes(contract);
        const file = `migration/contracts/${checkpoint.context.runId}/${sha256(bytes)}.json`;
        writeImmutable(payload, file, bytes);
        index.contracts ??= {};
        index.contracts[contract.id] = { path: file, bytes: bytes.length, sha256: sha256(bytes) };
        paths.push(file);
      }
      for (const artifact of artifacts) {
        relativePath(artifact.path);
        if (!artifact.path.startsWith("migration/publications/")) throw new Error("Invalid publication artifact path.");
        writeImmutable(payload, artifact.path, artifact.bytes);
        paths.push(artifact.path);
      }
      if (recomputation) index.recomputations = [...(index.recomputations ?? []), recomputation];
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
    const acknowledged = await this.store.recover({ retry: true });
    await this.load(acknowledged.commit);
    this.owned();
    await rememberWorkspace(this);
  }

  async recover({ retry = false } = {}) {
    await this.store.init();
    const result = await this.store.recover({ retry });
    await this.load(result.commit);
    // With no local proposal, the remote checkpoint is the recovery boundary.
    // Never infer that a lost, unpushed local result had completed.
    if (!this.session && this.index) {
      if (this.workspaceDirectory && this.control?.active) {
        throw new Error("A remote writer still owns the run; inspect and obtain explicit termination evidence before handoff.");
      }
      await this.prepareWorkspaceSource();
      await this.restore({ freshCheckout: true });
    }
    if (result.outcome === "acknowledged") await rememberWorkspace(this);
    return { ...result, ...this.status(), requiresHandoff: Boolean(this.control?.active && !this.session) };
  }

  inspect() {
    return { stateCommit: this.head, context: this.checkpoint?.context ?? null,
      owner: this.control?.active?.owner ?? null, generation: this.control?.generation ?? null,
      leaseExpiresAt: this.control?.active?.expiresAt ?? null,
      released: Boolean(this.control && !this.control.active),
      uncertain: Object.entries(this.checkpoint?.units ?? {}).filter(([, unit]) => unit.state === "intent").map(([id]) => id),
      publication: this.index?.publication ?? null };
  }

  async adopt(confirmation) {
    const previous = this.control;
    if (!previous?.active || !this.checkpoint) throw new Error("No active run to hand off; start a new run after release.");
    if (this.session) throw new Error("Remote handoff requires a new local session directory.");
    const evidence = endedConfirmation(confirmation, previous, this.head, this.now());
    if (this.config.owner === previous.active.owner) throw new Error("Remote handoff requires a new execution owner.");
    if (!same(this.config.context, this.checkpoint.context)) throw new Error("Frozen run context changed.");
    if (await this.store.head() !== this.head) throw new Error("State HEAD changed; obtain a new termination confirmation.");
    await this.restore({ freshCheckout: true });
    await this.verifySource();
    // The caller attests termination. We do not infer it from TTL, token
    // possession, a missing local lock, or a different host.
    const lease = { ...acquireLease({ ...previous, active: null }, {
      owner: this.config.owner, runId: previous.active.runId, now: this.now(), ttlMs: this.ttlMs,
    }), checkpoint: previous.checkpoint, lastHandoff: evidence };
    this.session = { remote: this.config.remote, ref: this.config.ref, context: this.checkpoint.context, lease };
    atomicJson(this.directory, "session.json", this.session);
    // A single-parent CAS and its independent acknowledgement precede any work.
    await this.persist({ control: lease });
    return { ...this.status(), adopted: true, generation: lease.generation };
  }

  async storedJob(id) {
    const pin = this.index?.contracts?.[id];
    if (!pin || !pin.path.startsWith(`migration/contracts/${this.checkpoint.context.runId}/`)) {
      throw new Error("No durable portable contract for this unit; legacy digest-only intents require their original reviewed contract.");
    }
    const bytes = await this.store.read(this.head, pin.path);
    if (!bytes || bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256) throw new Error("Durable contract pin mismatch.");
    const job = portableJob(JSON.parse(bytes), this);
    if (job.id !== id || !this.checkpoint.units[id]) throw new Error("Durable contract belongs to another unit.");
    beginUnit(this.checkpoint, jobRequest(job));
    return job;
  }

  async resolveJob(job) {
    if (typeof job === "string") return this.storedJob(job);
    const portable = portableJob(job, this);
    const existing = this.checkpoint?.units[job.id];
    // Read compatibility for the earlier digest-only format. A caller must
    // supply its exact old contract; no command is guessed from a digest.
    if (existing && !this.index.contracts?.[job.id] &&
        existing.inputSha256 === jobRequest(job).inputSha256) return job;
    return portable;
  }

  async restore({ freshCheckout = false } = {}) {
    if (!this.index) throw new Error("No durable bundle to restore.");
    const view = await this.store.materialize(this.head);
    const bundle = path.join(view, this.index.bundle.path);
    const { manifest } = verifyBundle({ bundle, manifestSha256: this.index.bundle.manifestSha256 });
    const prior = this.workspaceDirectory ? await priorWorkspace(this, manifest) : null;
    const replaceMatching = prior ?? new Map();
    if (freshCheckout) {
      await this.prepareWorkspaceSource();
      const base = (await this.store.git(this.root, ["rev-parse", "HEAD"])).toString().trim();
      if (!prior && ![this.checkpoint.context.repositoryBaseCommit, this.index.publication?.commit,
        this.config.context?.repositoryBaseCommit].includes(base)) {
        throw new Error("Fresh restore requires the frozen source checkout or its exact publication commit.");
      }
      // Only proven clean tracked baseline bytes may be replaced with newer
      // durable data. Ignored/untracked research and dirty edits still conflict.
      const tracked = new Set((await this.store.git(this.root, ["ls-files", "-z"])).toString().split("\0"));
      for (const entry of manifest.files) {
        if (!tracked.has(entry.path) || !existsSync(inside(this.root, entry.path, { missing: true }))) continue;
        const current = regularBytes(this.root, entry.path);
        if (sha256(current) !== entry.sha256) {
          const bytes = await this.store.git(this.root, ["show", `${base}:${entry.path}`]);
          if (!current.equals(bytes) && !replaceMatching.has(entry.path)) throw new Error("Tracked source baseline changed during restore.");
          if (current.equals(bytes)) replaceMatching.set(entry.path, bytes);
        }
      }
    }
    const result = restoreState({ bundle, target: this.root, manifestSha256: this.index.bundle.manifestSha256,
      expectedContext: manifest.context, replaceMatching });
    await rememberWorkspace(this);
    return result;
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

  async resume(confirmation) {
    // Retaining the token is not proof that an earlier worker has ended.
    if (!this.session || !this.checkpoint || !same(this.checkpoint.context, this.config.context)) {
      throw new Error("Original owner session and frozen context required.");
    }
    if (await this.store.head() !== this.head) throw new Error("State HEAD changed.");
    const evidence = endedConfirmation(confirmation, this.control, this.head, this.now());
    const previous = this.session;
    const released = releaseLease(this.control, previous.lease);
    const lease = { ...acquireLease(released, { owner: this.config.owner, runId: this.config.context.runId,
      now: this.now(), ttlMs: this.ttlMs }), checkpoint: this.control.checkpoint, lastHandoff: evidence };
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
    job = await this.resolveJob(job);
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
      checkpoint, exportBundle: true, contract: job });
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
      for (const command of argvs) {
        const argv = commandArgv(command);
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
    job = await this.resolveJob(job);
    if (!job.command) throw new Error("run requires a command argv; use begin for task-authored analysis.");
    const started = await this.begin(job);
    if (started.skipped) return started;
    await this.commands([job.command, job.validate]);
    return this.finish(job);
  }

  async reconcile(job) {
    job = await this.resolveJob(job);
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

  async recompute(decision) {
    await this.current();
    await this.verifySource();
    if (decision?.expectedStateCommit !== this.head || decision.confirmRecompute !== true ||
        decision.sideEffectsReconciled !== true || this.index.publication) {
      throw new Error("Recomputation requires the exact state commit, explicit consent and reconciled side effects, before publication.");
    }
    const evidence = confirmationRecord(decision, this.now());
    const job = await this.storedJob(decision.unitId);
    if (this.checkpoint.units[job.id].state !== "intent") throw new Error("Only an uncertain intent can be explicitly recomputed.");
    for (const input of job.inputs) verifyRecord(this.root, input);
    await this.persist({ recomputation: { ...evidence, unitId: job.id,
      generation: this.control.generation, sourceStateCommit: this.head,
      uncommittedWorkRestored: false } });
    if (!job.command) return { begun: true, unit: job.id, recomputationAuthorized: true, uncommittedWorkRestored: false };
    await this.commands([job.command, job.validate]);
    return { ...await this.finish(job), recomputed: true, uncommittedWorkRestored: false };
  }

  async finish(job) {
    await this.current();
    const checkpoint = completeUnit(this.checkpoint, { id: job.id, root: this.root,
      outputs: job.outputs.map((file) => record(this.root, file)) });
    await this.persist({ checkpoint, exportBundle: true });
    return { completed: job.id, stateCommit: this.head, sequence: this.checkpoint.sequence };
  }

  async journal(publication, artifacts = []) {
    await this.current();
    await this.persist({ publication, artifacts });
  }

  async release() {
    if (!this.control || !this.checkpoint) throw new Error("No initialized run.");
    if (Object.values(this.checkpoint.units).some((unit) => unit.state === "intent") ||
        (this.index.publication && this.index.publication.events.at(-1)?.type !== "verified")) {
      throw new Error("Reconcile unfinished intent/publication before releasing the run.");
    }
    if (await this.store.head() !== this.head) throw new Error("State HEAD changed.");
    if (!this.control.active) {
      return { released: true, stateCommit: this.head, disposable: true };
    }
    if (!this.session) throw new Error("Confirm remote handoff before releasing an abandoned active run.");
    const control = releaseLease(this.control, this.session.lease);
    await this.store.prepare(this.head, (payload) => {
      atomicJson(payload, CONTROL, control);
      return [CONTROL];
    });
    const acknowledged = await this.store.recover({ retry: true });
    await this.load(acknowledged.commit);
    await rememberWorkspace(this);
    return { released: true, stateCommit: this.head, disposable: true };
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
  if (!["start", "status", "inspect", "restore", "renew", "resume", "adopt", "begin", "run", "reconcile",
    "run-unit", "reconcile-unit", "recompute", "recover", "retry", "release", "unlock", "unlock-workspace", "publish"].includes(command) ||
      !configFile || argv.length > 3) throw new Error("Usage: runner.mjs COMMAND LOCAL_CONFIG.json [LOCAL_JOB.json]");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const workspace = workspaceDirectory(config, path.resolve(config.root), path.resolve(config.directory));
  if (command === "unlock-workspace") {
    if (!workspace || jobFile) throw new Error("unlock-workspace requires configured workspace metadata and no job.");
    return withSessionLock(workspace, async () => {}, { unlock: true });
  }
  const execute = () => withSessionLock(path.resolve(config.directory), async () => {
    const runner = new Runner(config);
    if (command === "recover" || command === "retry") return runner.recover({ retry: command === "retry" });
    await runner.open();
    if (["run-unit", "reconcile-unit"].includes(command)) {
      if (!jobFile) throw new Error("A durable unit ID is required.");
      return runner[command === "run-unit" ? "run" : "reconcile"](jobFile);
    }
    if (command === "publish") {
      const { publish } = await import("./publication.mjs");
      const job = jobFile ? JSON.parse(readFileSync(jobFile, "utf8")) : runner.index?.publication;
      if (!job) throw new Error("A publication specification or existing journal is required.");
      return publish(runner, job);
    }
    if (["begin", "run", "reconcile", "adopt", "resume", "recompute"].includes(command)) {
      if (!jobFile) throw new Error("A local job specification is required.");
      const job = JSON.parse(readFileSync(jobFile, "utf8"));
      return runner[command](job);
    }
    if (jobFile) throw new Error("This command takes no job specification.");
    return runner[command]();
  }, { unlock: command === "unlock" });
  // Different owner/session directories still share a single retained checkout.
  return workspace ? withSessionLock(workspace, execute) : execute();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
