import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Runner, main, withSessionLock } from "../runner.mjs";
import { git } from "../git-store.mjs";
import { publish } from "../publication.mjs";
import { jsonBytes, sha256 } from "../files.mjs";

const ref = "refs/heads/workspace-fixture";
const aggregate = "content/paper-reading/state/discovery-state.json";
const sourceCache = "local-assets/paper-reading/runs/history/fulltext/source-cache.json";
function write(root, file, value) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), typeof value === "string" ? value : jsonBytes(value));
}
const read = (root, file) => JSON.parse(readFileSync(path.join(root, file)));
const remoteHead = async (f) => (await git(f.remote, ["rev-parse", ref])).toString().trim();
const localConfig = (f, owner, context = f.context) => ({
  root: f.root, directory: path.join(f.directory, owner), workspaceDirectory: f.workspace,
  remote: f.remote, ref, owner, context: { ...context, runId: owner },
  source: { remote: f.publicRemote, ref },
});
async function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "persistent-paper-workspace-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = { directory, root: path.join(directory, "retained-code"),
    workspace: path.join(directory, "workspace-metadata"),
    remote: path.join(directory, "state.git"), publicRemote: path.join(directory, "public.git") };
  const seed = path.join(directory, "seed");
  mkdirSync(seed); mkdirSync(f.root);
  await git(directory, ["init", "--bare", f.remote]);
  await git(directory, ["init", "--bare", f.publicRemote]);
  await git(seed, ["init"]);
  write(seed, "README.md", "Synthetic private state\n");
  await git(seed, ["add", "README.md"]); await git(seed, ["commit", "-m", "Synthetic private base"]);
  await git(seed, ["push", f.remote, `HEAD:${ref}`]);
  await git(f.root, ["init"]);
  write(f.root, "README.md", "Synthetic reviewed source\n");
  write(f.root, ".gitignore", "local-assets/\ncount\nnotes.txt\n");
  write(f.root, aggregate, { state: "initial" });
  await git(f.root, ["add", "README.md", ".gitignore", aggregate]);
  await git(f.root, ["commit", "-m", "Synthetic public base"]);
  f.base = (await git(f.root, ["rev-parse", "HEAD"])).toString().trim();
  await git(f.root, ["push", f.publicRemote, `${f.base}:${ref}`]);
  write(f.root, sourceCache, { runId: "history", revision: 0 });
  write(f.root, "notes.txt", "User notes must survive\n");
  f.context = { runId: "local-first", mode: "daily", repositoryBaseCommit: f.base,
    codeSnapshotSha256: sha256(await git(f.root, ["archive", "--format=tar", f.base])),
    window: { start: "2026-10-20T00:00:00Z", end: "2026-10-21T00:00:00Z" },
    policyFingerprint: `sha256:${"a".repeat(64)}` };
  f.config = { ...localConfig(f, "local-first"), initializeFromRoot: true, expectedStateCommit: await remoteHead(f) };
  f.runner = await new Runner(f.config).open();
  await f.runner.start();
  return f;
}
function unit(id, stage = "discovery", outputs = [`content/paper-reading/papers/${id}.json`]) {
  return { id, stage, inputs: [], outputs,
    command: ["node", "-e", "const fs=require('node:fs'),p=require('node:path');" +
      `for(const file of ${JSON.stringify(outputs)}){fs.mkdirSync(p.dirname(file),{recursive:true});` +
      `fs.writeFileSync(file,JSON.stringify(file.includes('/history/')?{runId:'history',revision:${JSON.stringify(id)}}:{value:${JSON.stringify(id)}}));}` +
      "fs.appendFileSync('count','x');"],
    validate: ["node", "-e", `for(const file of ${JSON.stringify(outputs)})JSON.parse(require('node:fs').readFileSync(file));`] };
}
async function cloud(f, owner = "cloud-next") {
  const root = path.join(f.directory, owner + "-code");
  await git(f.directory, ["clone", "--no-local", "--branch", ref.slice(11), f.publicRemote, root]);
  const runner = await new Runner({ root, directory: path.join(f.directory, owner), remote: f.remote, ref, owner,
    context: { ...f.context, runId: owner } }).open();
  await runner.start();
  return runner;
}
const verify = async ({ commit }) => ({ commit, state: "success", deploymentId: 1, statusId: 2 });

test("retained code updates only proven previous state after cloud release, preserving HEAD, index and user notes", async (t) => {
  const f = await fixture(t);
  await f.runner.run(unit("local-output", "discovery", [aggregate, sourceCache]));
  await f.runner.release();
  const inode = statSync(path.join(f.root, ".git")).ino;
  const index = readFileSync(path.join(f.root, ".git/index"));
  const other = await cloud(f);
  await other.run(unit("cloud-output", "discovery", [aggregate, sourceCache]));
  await other.release();
  const oldBaseline = readFileSync(path.join(f.workspace, "baseline.json"));
  await assert.rejects(new Runner(f.config).recover(), /hash\/length/);
  assert.deepEqual(readFileSync(path.join(f.workspace, "baseline.json")), oldBaseline,
    "Reading a newer run with a stale session must not relabel old local bytes as restored");
  const next = await new Runner(localConfig(f, "local-return")).open();
  await next.start();
  assert.deepEqual(read(f.root, aggregate), { value: "cloud-output" });
  assert.equal(read(f.root, sourceCache).revision, "cloud-output");
  assert.equal(statSync(path.join(f.root, ".git")).ino, inode);
  assert.equal((await git(f.root, ["rev-parse", "HEAD"])).toString().trim(), f.base);
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), index);
  assert.equal(readFileSync(path.join(f.root, "notes.txt"), "utf8"), "User notes must survive\n");
  assert.equal(next.control.active.owner, "local-return");
  assert.equal(read(f.workspace, "baseline.json").stateCommit, await remoteHead(f));
});

test("cloud publication and acknowledged release allow a retained local checkout to fetch the next public base automatically", async (t) => {
  const f = await fixture(t);
  await f.runner.release();
  const other = await cloud(f);
  for (const stage of ["content", "receipt-ledger", "finalize"]) await other.run(unit(stage, stage));
  await git(other.root, ["add", "--", "content/paper-reading"]);
  await git(other.root, ["commit", "-m", "Synthetic publication"]);
  const commit = (await git(other.root, ["rev-parse", "HEAD"])).toString().trim();
  const target = { remote: f.publicRemote, ref, commit };
  const pending = await publish(other, target, { verify: async ({ commit }) => ({ commit, state: "pending" }) });
  assert.equal(pending.complete, false);
  await assert.rejects(new Runner(localConfig(f, "blocked-unverified")).open().then(r => r.start()), /writer is active/);
  const published = await publish(other, target, { verify });
  assert.equal(published.released, true);
  const context = { ...f.context, repositoryBaseCommit: commit,
    codeSnapshotSha256: sha256(await git(other.root, ["archive", "--format=tar", commit])) };
  const index = readFileSync(path.join(f.root, ".git/index"));
  const next = await new Runner(localConfig(f, "local-after-publication", context)).open();
  await next.start();
  assert.deepEqual(read(f.root, "content/paper-reading/papers/content.json"), { value: "content" });
  assert.equal((await git(f.root, ["rev-parse", "HEAD"])).toString().trim(), f.base);
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), index);
  assert.equal(next.checkpoint.context.repositoryBaseCommit, commit);
  // The controller builds the public candidate on the frozen public base with
  // a disposable index. A retained checkout's HEAD can remain on an older base.
  const outputs = [];
  for (const stage of ["content", "receipt-ledger", "finalize"]) {
    const job = unit(`local-${stage}`, stage); outputs.push(...job.outputs); await next.run(job);
  }
  const options = { env: { GIT_INDEX_FILE: path.join(f.directory, "publication.index") } };
  await git(f.root, ["read-tree", commit], options);
  await git(f.root, ["--work-tree", f.root, "add", "--", ...outputs], options);
  const tree = (await git(f.root, ["write-tree"], options)).toString().trim();
  const localCommit = (await git(f.root, ["commit-tree", tree, "-p", commit, "-m", "Synthetic local publication"])).toString().trim();
  assert.equal((await publish(next, { remote: f.publicRemote, ref, commit: localCommit }, { verify })).released, true);
  assert.equal((await git(f.publicRemote, ["rev-parse", ref])).toString().trim(), localCommit);
  assert.equal((await git(f.root, ["rev-parse", "HEAD"])).toString().trim(), f.base);
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), index);
});

test("active or expired cloud ownership blocks local start and recovery before changing retained data", async (t) => {
  const f = await fixture(t); await f.runner.release();
  const other = await cloud(f);
  await other.run(unit("cloud-active", "discovery", [aggregate]));
  const before = readFileSync(path.join(f.root, aggregate));
  const baseline = readFileSync(path.join(f.workspace, "baseline.json"));
  const expectedHead = await remoteHead(f);
  for (const expired of [false, true]) {
    const config = localConfig(f, expired ? "expired-blocked" : "active-blocked");
    const options = expired ? { now: () => Date.parse(other.control.active.expiresAt) + 1000 } : {};
    const next = await new Runner(config, options).open();
    await assert.rejects(next.start(), /writer is active/);
    const reader = new Runner({ ...config, context: undefined }, options);
    await assert.rejects(reader.recover(), /remote writer still owns/);
  }
  assert.equal(await remoteHead(f), expectedHead);
  assert.deepEqual(readFileSync(path.join(f.root, aggregate)), before);
  assert.deepEqual(readFileSync(path.join(f.workspace, "baseline.json")), baseline);
});

test("unacknowledged local edits and staged changes are retained and prevent automatic restore", async (t) => {
  const f = await fixture(t); await f.runner.run(unit("first", "discovery", [aggregate])); await f.runner.release();
  const other = await cloud(f); await other.run(unit("newer", "discovery", [aggregate])); await other.release();
  write(f.root, aggregate, { userEdit: true });
  const before = await remoteHead(f);
  const next = await new Runner(localConfig(f, "dirty-blocked")).open();
  await assert.rejects(next.start(), /baseline changed|hash\/length/);
  assert.deepEqual(read(f.root, aggregate), { userEdit: true });
  write(f.root, "README.md", "Staged user source edit\n");
  await git(f.root, ["add", "README.md"]);
  const index = readFileSync(path.join(f.root, ".git/index"));
  await assert.rejects(next.start(), /Staged user changes/);
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), index);
  assert.equal(await remoteHead(f), before);
});

test("an unavailable private remote never falls back to stale local progress", async (t) => {
  const f = await fixture(t); await f.runner.release();
  const before = readFileSync(path.join(f.root, aggregate));
  const unavailable = async (cwd, args, options) => {
    if (args[0] === "ls-remote" && args.includes("--exit-code")) throw new Error("Synthetic state remote unavailable");
    return git(cwd, args, options);
  };
  await assert.rejects(new Runner(localConfig(f, "offline-blocked"), { runGit: unavailable }).open(), /remote unavailable/);
  assert.deepEqual(readFileSync(path.join(f.root, aggregate)), before);
});

for (const accepted of [true, false]) {
  test(`persistent baseline distinguishes a lost ${accepted ? "accepted" : "unapplied"} completion push`, async (t) => {
    const f = await fixture(t);
    const job = unit("once"); await f.runner.begin(job);
    write(f.root, job.outputs[0], { value: "once" });
    const baseline = readFileSync(path.join(f.workspace, "baseline.json"));
    let blind = false;
    f.runner.store.git = async (cwd, args, options) => {
      if (blind && args[0] === "ls-remote") throw new Error("Synthetic lost readback");
      if (args[0] === "push") {
        if (accepted) await git(cwd, args, options);
        blind = true; throw new Error("Synthetic lost reply");
      }
      return git(cwd, args, options);
    };
    await assert.rejects(f.runner.finish(job), error => error.outcome === "unknown");
    assert.deepEqual(readFileSync(path.join(f.workspace, "baseline.json")), baseline);
    const next = new Runner(f.config);
    if (accepted) assert.equal((await next.recover()).outcome, "acknowledged");
    else {
      await assert.rejects(next.recover(), error => error.outcome === "not-applied");
      assert.deepEqual(readFileSync(path.join(f.workspace, "baseline.json")), baseline);
      assert.equal((await next.recover({ retry: true })).outcome, "acknowledged");
    }
    assert.equal((await next.run(job)).skipped, true);
    assert.equal(existsSync(path.join(f.root, "count")), false, "Recovery did not execute research again");
    assert.equal(read(f.workspace, "baseline.json").stateCommit, await remoteHead(f));
  });
}

test("remote deletion and a corrupted local baseline fail without deleting or resurrecting retained artifacts", async (t) => {
  const f = await fixture(t); await f.runner.run(unit("old")); await f.runner.release();
  const other = await cloud(f);
  const replacement = unit("replacement");
  replacement.command[2] += "require('node:fs').unlinkSync('content/paper-reading/papers/old.json');";
  await other.run(replacement); await other.release();
  const before = await remoteHead(f);
  const next = await new Runner(localConfig(f, "deletion-blocked")).open();
  await assert.rejects(next.start(), /removed a retained/);
  assert.equal(existsSync(path.join(f.root, "content/paper-reading/papers/old.json")), true);
  assert.equal(existsSync(path.join(f.root, replacement.outputs[0])), false);
  const baseline = read(f.workspace, "baseline.json");
  write(f.workspace, "baseline.json", { ...baseline, manifestSha256: "f".repeat(64) });
  await assert.rejects(next.start(), /acknowledged private index/);
  assert.equal(await remoteHead(f), before);
});

test("different CLI session directories serialize access to the same persistent checkout", async (t) => {
  const f = await fixture(t); await f.runner.release();
  const config = localConfig(f, "competing-session");
  const file = path.join(f.directory, "competing-config.json"); write(f.directory, "competing-config.json", config);
  const before = await remoteHead(f);
  await withSessionLock(f.workspace, async () => {
    await assert.rejects(main(["start", file]), /Session is locked/);
    await assert.rejects(main(["unlock-workspace", file]), /Previous process still exists/);
  });
  assert.equal(await remoteHead(f), before);
});
