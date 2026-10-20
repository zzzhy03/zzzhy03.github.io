import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Runner } from "../runner.mjs";
import { git } from "../git-store.mjs";
import { publish } from "../publication.mjs";
import { portableJob } from "../contracts.mjs";
import { jsonBytes, sha256 } from "../files.mjs";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../runner.mjs", import.meta.url));
const ref = "refs/heads/ephemeral-fixture";
const aggregate = "content/paper-reading/state/discovery-state.json";
function write(root, file, value) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), typeof value === "string" ? value : jsonBytes(value));
}
const head = async (remote) => (await git(remote, ["rev-parse", ref])).toString().trim();

async function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ephemeral-runner-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = path.join(directory, "state.git");
  const publicRemote = path.join(directory, "public.git");
  const seed = path.join(directory, "seed");
  const execution = path.join(directory, "executor-1");
  const root = path.join(execution, "research");
  mkdirSync(seed); mkdirSync(root, { recursive: true });
  await git(directory, ["init", "--bare", remote]);
  await git(directory, ["init", "--bare", publicRemote]);
  await git(seed, ["init"]);
  write(seed, "README.md", "Synthetic private state\n");
  await git(seed, ["add", "."]);
  await git(seed, ["commit", "-m", "Synthetic state"]);
  await git(seed, ["push", remote, `HEAD:${ref}`]);
  await git(root, ["init"]);
  write(root, "README.md", "Synthetic reviewed source\n");
  write(root, ".gitignore", "local-assets/\nlocal-count\n");
  write(root, aggregate, { successful: 0 });
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "Synthetic source"]);
  const base = (await git(root, ["rev-parse", "HEAD"])).toString().trim();
  await git(root, ["push", publicRemote, `${base}:${ref}`]);
  const context = {
    runId: "ephemeral-run", mode: "daily", repositoryBaseCommit: base,
    codeSnapshotSha256: sha256(await git(root, ["archive", "--format=tar", base])),
    window: { start: "2026-10-19T00:00:00Z", end: "2026-10-20T00:00:00Z" },
    policyFingerprint: `sha256:${"a".repeat(64)}`,
  };
  const config = { root, directory: path.join(execution, "session"), remote, ref, owner: "executor-1", context,
    initializeFromRoot: true, expectedStateCommit: await head(remote) };
  const runner = await new Runner(config).open();
  await runner.start();
  return { directory, remote, publicRemote, base, context, execution, config, runner, sequence: 1 };
}

function unit(id = "discover", stage = "discovery", { modifiesAggregate = false, manual = false } = {}) {
  const file = modifiesAggregate ? aggregate : `content/paper-reading/papers/${id}.json`;
  const command = [process.execPath, "-e",
    "const fs=require('node:fs');fs.mkdirSync('content/paper-reading/papers',{recursive:true});" +
    `fs.appendFileSync('local-count',${JSON.stringify(`${id}\n`)});` +
    `fs.writeFileSync(${JSON.stringify(file)},JSON.stringify({unit:${JSON.stringify(id)}}));`];
  return { id, stage, inputs: [], outputs: [file], ...(manual ? {} : { command }),
    validate: [process.execPath, "-e",
      `const fs=require('node:fs');if(!fs.existsSync(${JSON.stringify(file)}))process.exit(2);JSON.parse(fs.readFileSync(${JSON.stringify(file)}));`] };
}

function discard(runner) {
  const execution = path.dirname(runner.directory);
  rmSync(execution, { recursive: true });
  assert.equal(existsSync(runner.root), false);
  assert.equal(existsSync(runner.directory), false);
}

async function fresh(f, options = {}) {
  const execution = path.join(f.directory, `executor-${++f.sequence}`);
  const root = path.join(execution, "research");
  mkdirSync(execution);
  // Source comes solely from the public bare remote. No old checkout, session,
  // pending.json, object cache, alternates or hardlinks is reused.
  await git(execution, ["clone", "--no-local", "--branch", ref.slice(11), f.publicRemote, root]);
  await git(root, ["checkout", "--detach", f.base]);
  const config = { root, directory: path.join(execution, "session"), remote: f.remote, ref, owner: `executor-${f.sequence}` };
  assert.equal(existsSync(config.directory), false);
  assert.equal(existsSync(path.join(root, ".git/objects/info/alternates")), false);
  return new Runner(config, options);
}

const ended = (runner, extra = {}) => ({
  previousInstanceEnded: true, expectedStateCommit: runner.head,
  previousOwner: runner.control.active.owner, previousRunId: runner.control.active.runId,
  previousGeneration: runner.control.generation,
  confirmedBy: "fixture-operator", reason: "The synthetic previous executor has ended; no child process is running.",
  ...extra,
});

async function candidate(f) {
  for (const stage of ["content", "receipt-ledger", "finalize"]) await f.runner.run(unit(stage, stage));
  await git(f.runner.root, ["add", "--", "content/paper-reading"]);
  await git(f.runner.root, ["commit", "-m", "Synthetic publication candidate"]);
  return { remote: f.publicRemote, ref, commit: (await git(f.runner.root, ["rev-parse", "HEAD"])).toString().trim() };
}
const verify = async ({ commit }) => ({ commit, state: "success", deploymentId: 1, statusId: 2 });

test("new daily run after acknowledged release needs only fresh clones, not any previous local files", async (t) => {
  const f = await fixture(t);
  await f.runner.run(unit("durable"));
  const released = await f.runner.release();
  assert.equal(released.disposable, true);
  assert.equal(await head(f.remote), released.stateCommit);
  discard(f.runner);
  const empty = await fresh(f);
  const next = await new Runner({ ...empty.config, context: { ...f.context, runId: "next-daily-run" } }).open();
  await next.start();
  assert.equal(next.control.active.owner, next.config.owner);
  assert.equal(next.checkpoint.context.runId, "next-daily-run");
  assert.equal(JSON.parse(readFileSync(path.join(next.root, "content/paper-reading/papers/durable.json"))).unit, "durable");
  assert.equal(existsSync(path.join(next.root, "local-count")), false);
});

test("lost session restores remote context, tracked state and contracts; unconfirmed or stale takeover fails closed", async (t) => {
  const f = await fixture(t);
  await f.runner.run(unit("aggregate", "discovery", { modifiesAggregate: true }));
  const previousToken = f.runner.control.active.token;
  discard(f.runner);
  const next = await fresh(f);
  const recovered = await next.recover();
  assert.equal(recovered.requiresHandoff, true);
  assert.deepEqual(next.config.context, f.context);
  assert.equal(JSON.parse(readFileSync(path.join(next.root, aggregate))).unit, "aggregate");
  const before = await head(f.remote);
  await assert.rejects(next.start(), /writer is active/);
  await assert.rejects(next.adopt({}), /Confirm the exact previous instance/);
  await assert.rejects(next.adopt(ended(next, { previousGeneration: 0 })), /Confirm the exact previous instance/);
  await assert.rejects(next.adopt(ended(next, { previousInstanceEnded: false })), /Confirm the exact previous instance/);
  assert.equal(await head(f.remote), before);
  await next.adopt(ended(next));
  assert.notEqual(next.control.active.token, previousToken);
  assert.equal(next.control.generation, 2);
  assert.equal(next.control.lastHandoff.previousStateCommit, before);
  assert.equal((await next.run("aggregate")).skipped, true);
  assert.equal(existsSync(path.join(next.root, "local-count")), false);
  const contract = await next.storedJob("aggregate");
  assert.equal(contract.command[0], "node");
  assert.ok(!JSON.stringify(contract).includes(f.execution));
});

test("lost local output remains an uncertain intent; only explicit audited recomputation runs it again", async (t) => {
  const f = await fixture(t);
  const job = unit("uncommitted");
  await f.runner.begin(job);
  await execute(job.command[0], job.command.slice(1), { cwd: f.runner.root });
  assert.equal(existsSync(path.join(f.runner.root, job.outputs[0])), true);
  discard(f.runner);
  const next = await fresh(f);
  await next.recover();
  assert.equal(existsSync(path.join(next.root, job.outputs[0])), false);
  await next.adopt(ended(next));
  await assert.rejects(next.run("uncommitted"), /Uncertain intent/);
  await assert.rejects(next.reconcile("uncommitted"), /command failed/);
  const before = await head(f.remote);
  await assert.rejects(next.recompute({ unitId: "uncommitted" }), /explicit consent/);
  assert.equal(await head(f.remote), before);
  const result = await next.recompute({ unitId: "uncommitted", expectedStateCommit: next.head,
    confirmRecompute: true, sideEffectsReconciled: true, confirmedBy: "fixture-operator",
    reason: "The lost command only wrote a local JSON file; recomputation is approved." });
  assert.equal(result.recomputed, true);
  assert.equal(result.uncommittedWorkRestored, false);
  assert.equal(next.index.recomputations.length, 1);
  assert.equal(readFileSync(path.join(next.root, "local-count"), "utf8"), "uncommitted\n");
  assert.equal((await next.run("uncommitted")).skipped, true);
});

for (const accepted of [true, false]) {
  test(`unknown completion push ${accepted ? "accepted" : "not accepted"} is resolved from remote without pending or cache`, async (t) => {
    const f = await fixture(t);
    const job = unit("unknown");
    await f.runner.begin(job);
    await execute(job.command[0], job.command.slice(1), { cwd: f.runner.root });
    let blind = false;
    f.runner.store.git = async (cwd, args, options) => {
      if (blind && args[0] === "ls-remote") throw new Error("Synthetic readback loss");
      if (args[0] === "push") {
        if (accepted) await git(cwd, args, options);
        blind = true;
        throw new Error("Synthetic push reply loss");
      }
      return git(cwd, args, options);
    };
    await assert.rejects(f.runner.finish(job), (error) => error.outcome === "unknown");
    assert.ok(f.runner.store.pending());
    discard(f.runner);
    const next = await fresh(f);
    await next.recover();
    await next.adopt(ended(next));
    assert.equal(next.checkpoint.units.unknown.state, accepted ? "complete" : "intent");
    assert.equal(existsSync(path.join(next.root, job.outputs[0])), accepted);
    if (accepted) assert.equal((await next.run("unknown")).skipped, true);
    else await assert.rejects(next.run("unknown"), /Uncertain intent/);
    assert.equal(existsSync(path.join(next.root, "local-count")), false);
  });
}

test("an expired unreleased lease never auto-transfers; confirmed CAS takeover fences revived old writers and their pending commit", async (t) => {
  const f = await fixture(t);
  const old = f.runner;
  await old.run(unit("durable"));
  await old.store.prepare(old.head, (payload) => {
    write(payload, "migration/old-writer.json", { shouldNeverApply: true });
    return ["migration/old-writer.json"];
  });
  const next = await fresh(f, { now: () => Date.now() + 600_000 });
  await next.recover();
  await assert.rejects(next.start(), /writer is active/);
  await next.adopt(ended(next));
  const acknowledged = await head(f.remote);
  await assert.rejects(old.renew(), /HEAD changed/);
  await assert.rejects(old.run(unit("stale")), /HEAD changed/);
  await assert.rejects(old.release(), /HEAD changed/);
  await assert.rejects(old.store.recover({ retry: true }), (error) => error.outcome === "conflict");
  await assert.rejects(publish(old, { remote: f.publicRemote, ref, commit: f.base }, { verify }), /HEAD changed/);
  assert.equal(await head(f.remote), acknowledged);
  assert.equal(await head(f.publicRemote), f.base);
  assert.equal(existsSync(path.join(old.root, "content/paper-reading/papers/stale.json")), false);
});

test("two confirmed replacement executors race the same remote parent and exactly one acquires ownership", async (t) => {
  const f = await fixture(t);
  discard(f.runner);
  const a = await fresh(f), b = await fresh(f);
  await a.recover(); await b.recover();
  const result = await Promise.allSettled([a.adopt(ended(a)), b.adopt(ended(b))]);
  assert.equal(result.filter((value) => value.status === "fulfilled").length, 1);
  const winner = result[0].status === "fulfilled" ? a : b;
  const loser = winner === a ? b : a;
  assert.equal(await head(f.remote), winner.head);
  await assert.rejects(loser.run(unit("must-not-run")));
  assert.equal(existsSync(path.join(loser.root, "local-count")), false);
});

test("task-authored analysis restores its instructions and explicitly reauthors lost work without a fake command recovery", async (t) => {
  const f = await fixture(t);
  const job = { ...unit("analysis", "fulltext", { manual: true }), instructions: "Inspect the pinned inputs and author the synthetic review JSON." };
  await f.runner.begin(job);
  write(f.runner.root, job.outputs[0], { localDraft: true });
  discard(f.runner);
  const next = await fresh(f);
  await next.recover();
  await next.adopt(ended(next));
  assert.equal((await next.storedJob("analysis")).instructions, job.instructions);
  const result = await next.recompute({ expectedStateCommit: next.head, unitId: "analysis",
    confirmRecompute: true, sideEffectsReconciled: true, confirmedBy: "fixture-operator",
    reason: "The unsaved local review must be reauthored." });
  assert.equal(result.recomputationAuthorized, true);
  assert.equal(result.uncommittedWorkRestored, false);
  assert.equal(existsSync(path.join(next.root, job.outputs[0])), false);
  write(next.root, job.outputs[0], { reauthored: true });
  await next.reconcile("analysis");
  assert.equal(next.checkpoint.units.analysis.state, "complete");
  assert.equal(existsSync(path.join(next.root, "local-count")), false);
});

test("a private publication pack survives loss of every local Git object; publish restores exact SHA and acknowledges release", async (t) => {
  const f = await fixture(t);
  const publication = await candidate(f);
  let publicPushes = 0;
  const fault = async (cwd, args, options) => {
    if (args[0] === "push" && args[1] === f.publicRemote) {
      publicPushes++;
      throw new Error("Synthetic public push unavailable");
    }
    return git(cwd, args, options);
  };
  await assert.rejects(publish(f.runner, publication, { runGit: fault, verify }), /not acknowledged/);
  assert.ok(f.runner.index.publication.artifact);
  assert.equal(await head(f.publicRemote), f.base);
  discard(f.runner);
  const next = await fresh(f);
  await next.recover();
  await assert.rejects(git(next.root, ["cat-file", "-e", publication.commit]));
  await next.adopt(ended(next));
  const indexBefore = readFileSync(path.join(next.root, ".git/index"));
  const result = await publish(next, next.index.publication, { verify });
  assert.equal(result.complete, true);
  assert.equal(result.released, true);
  assert.equal(result.disposable, true);
  assert.equal(await head(f.publicRemote), publication.commit);
  assert.equal(await head(f.remote), result.stateCommit);
  assert.equal(next.control.active, null);
  assert.equal(publicPushes, 1);
  assert.equal(existsSync(path.join(next.root, "local-count")), false);
  assert.deepEqual(readFileSync(path.join(next.root, ".git/index")), indexBefore);
  discard(next);
  const after = await fresh(f);
  await after.recover();
  assert.equal((await after.release()).disposable, true);
});

test("unknown final release does not report publication complete until a new executor confirms the remote release", async (t) => {
  const f = await fixture(t);
  const publication = await candidate(f);
  let blind = false, inject = false;
  f.runner.store.git = async (cwd, args, options) => {
    if (blind && args[0] === "ls-remote") throw new Error("Synthetic final readback unavailable");
    const result = await git(cwd, args, options);
    if (inject && args[0] === "push" && args[1] === f.remote &&
        f.runner.index.publication?.events.at(-1)?.type === "verified") {
      blind = true;
      throw new Error("Synthetic release reply lost");
    }
    return result;
  };
  inject = true;
  await assert.rejects(publish(f.runner, publication, { verify }), (error) => error.outcome === "unknown");
  assert.equal(await head(f.publicRemote), publication.commit);
  discard(f.runner);
  const next = await fresh(f);
  const recovered = await next.recover();
  assert.equal(recovered.requiresHandoff, false);
  assert.equal(next.index.publication.events.at(-1).type, "verified");
  assert.equal((await next.release()).disposable, true);
});

test("unknown public push accepted before container loss is verified once, without another public push or research", async (t) => {
  const f = await fixture(t);
  const publication = await candidate(f);
  let blind = false, pushes = 0;
  const fault = async (cwd, args, options) => {
    if (blind && args[0] === "ls-remote" && args.includes(f.publicRemote)) throw new Error("Synthetic public readback loss");
    const result = await git(cwd, args, options);
    if (args[0] === "push" && args[1] === f.publicRemote) {
      blind = true; pushes++;
      throw new Error("Synthetic public reply loss");
    }
    return result;
  };
  await assert.rejects(publish(f.runner, publication, { runGit: fault, verify }), /outcome unknown/);
  discard(f.runner);
  const next = await fresh(f);
  await next.recover();
  await next.adopt(ended(next));
  const count = async (cwd, args, options) => {
    if (args[0] === "push" && args[1] === f.publicRemote) pushes++;
    return git(cwd, args, options);
  };
  const result = await publish(next, next.index.publication, { runGit: count, verify });
  assert.equal(result.released, true);
  assert.equal(pushes, 1);
  assert.equal(existsSync(path.join(next.root, "local-count")), false);
});

test("release reply loss after acceptance is recoverable in a new executor with no old session", async (t) => {
  const f = await fixture(t);
  await f.runner.run(unit("done"));
  let blind = false;
  f.runner.store.git = async (cwd, args, options) => {
    if (blind && args[0] === "ls-remote") throw new Error("Synthetic readback failure");
    const result = await git(cwd, args, options);
    if (args[0] === "push") { blind = true; throw new Error("Synthetic lost release acknowledgement"); }
    return result;
  };
  await assert.rejects(f.runner.release(), (error) => error.outcome === "unknown");
  discard(f.runner);
  const next = await fresh(f);
  const result = await next.recover();
  assert.equal(result.requiresHandoff, false);
  assert.equal((await next.release()).disposable, true);
});

test("fresh recovery refuses to overwrite unsaved tracked data", async (t) => {
  const f = await fixture(t);
  await f.runner.run(unit("changed", "discovery", { modifiesAggregate: true }));
  discard(f.runner);
  const next = await fresh(f);
  write(next.root, aggregate, { unsaved: "must survive" });
  await assert.rejects(next.recover(), /baseline changed/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(next.root, aggregate))), { unsaved: "must survive" });
});

test("CLI inspect/recover/adopt/run-unit work with only remote coordinates, new paths and an explicit new owner", async (t) => {
  const f = await fixture(t);
  await f.runner.run(unit("cli-done"));
  discard(f.runner);
  const next = await fresh(f);
  const configFile = path.join(path.dirname(next.root), "config.json");
  write(path.dirname(next.root), "config.json", next.config);
  const invoke = async (command, extra = []) => JSON.parse((await execute(process.execPath, [cli, command, configFile, ...extra])).stdout);
  const inspection = await invoke("inspect");
  assert.deepEqual(inspection.context, f.context);
  assert.equal(inspection.owner, "executor-1");
  assert.equal(JSON.stringify(inspection).includes('"token"'), false);
  assert.equal((await invoke("recover")).requiresHandoff, true);
  const confirmationFile = path.join(path.dirname(next.root), "confirmation.json");
  write(path.dirname(next.root), "confirmation.json", {
    previousInstanceEnded: true, expectedStateCommit: inspection.stateCommit,
    previousOwner: inspection.owner, previousRunId: inspection.context.runId, previousGeneration: inspection.generation,
    confirmedBy: "fixture-operator", reason: "The synthetic first executor directory has been deleted and no process remains.",
  });
  assert.equal((await invoke("adopt", [confirmationFile])).adopted, true);
  assert.equal((await invoke("run-unit", ["cli-done"])).skipped, true);
  assert.equal((await invoke("release")).disposable, true);
});

test("portable contract rejects machine paths and embedded credential arguments", () => {
  const job = unit();
  assert.equal(portableJob(job).command[0], "node");
  assert.throws(() => portableJob({ ...job, command: ["node", "/old/container/job.mjs"] }), /Portable argv/);
  assert.throws(() => portableJob({ ...job, validate: ["node", "validate.mjs", "--token=secret"] }), /Portable argv/);
});
