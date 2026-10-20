import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GitStore, git, validateRemote } from "../git-store.mjs";
import { Runner, withSessionLock } from "../runner.mjs";
import { publish, verifyGitHubPages } from "../publication.mjs";
import { jsonBytes, sha256 } from "../files.mjs";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../runner.mjs", import.meta.url));
const ref = "refs/heads/fixture";
function write(root, file, value) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), typeof value === "string" ? value : jsonBytes(value));
}
async function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "runner-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "research");
  const remote = path.join(directory, "state.git");
  const seed = path.join(directory, "seed");
  mkdirSync(root); mkdirSync(seed);
  await git(directory, ["init", "--bare", remote]);
  await git(seed, ["init"]);
  write(seed, "README.md", "Synthetic test state\n");
  await git(seed, ["add", "."]);
  await git(seed, ["commit", "-m", "Synthetic state base"]);
  await git(seed, ["push", remote, `HEAD:${ref}`]);
  const stateBase = (await git(seed, ["rev-parse", "HEAD"])).toString().trim();
  await git(root, ["init"]);
  write(root, "README.md", "Synthetic test source\n");
  write(root, ".gitignore", "local-assets/\n");
  write(root, "content/paper-reading/state/discovery-state.json", { fixture: true });
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "Synthetic source base"]);
  const base = (await git(root, ["rev-parse", "HEAD"])).toString().trim();
  const config = { root, directory: path.join(directory, "session"), remote, ref, owner: "test-owner",
    initializeFromRoot: true, expectedStateCommit: stateBase,
    context: { runId: "fixture-run", mode: "daily", repositoryBaseCommit: base,
      codeSnapshotSha256: sha256(await git(root, ["archive", "--format=tar", base])),
      window: { start: "2026-10-19T00:00:00Z", end: "2026-10-20T00:00:00Z" },
      policyFingerprint: `sha256:${"a".repeat(64)}` } };
  return { directory, root, remote, seed, config, base, stateBase };
}
function job(id = "discover", stage = "discovery", delay = 0) {
  const output = `content/paper-reading/papers/${id}.json`;
  const program = `const fs=require('node:fs');fs.mkdirSync('content/paper-reading/papers',{recursive:true});` +
    `fs.appendFileSync('local-count','x');fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({unit:${JSON.stringify(id)}}));` +
    (delay ? `setTimeout(()=>{},${delay});` : "");
  return { id, stage, inputs: [], outputs: [output], command: [process.execPath, "-e", program],
    validate: [process.execPath, "-e", `JSON.parse(require('node:fs').readFileSync(${JSON.stringify(output)}));`] };
}
async function started(f, options) {
  const runner = await new Runner(f.config, options).open();
  await runner.start();
  return runner;
}

test("real CLI persists intent/output, skips acknowledged work across processes, and restores exact bytes", async (t) => {
  const f = await fixture(t);
  write(f.directory, "config.json", f.config);
  write(f.directory, "job.json", job());
  const invoke = async (command, extra = []) => {
    const result = await execute(process.execPath, [cli, command, path.join(f.directory, "config.json"), ...extra]);
    return JSON.parse(result.stdout);
  };
  await invoke("start");
  assert.equal((await invoke("run", [path.join(f.directory, "job.json")])).completed, "discover");
  assert.equal((await invoke("run", [path.join(f.directory, "job.json")])).skipped, true);
  assert.equal(readFileSync(path.join(f.root, "local-count"), "utf8"), "x");
  const runner = await new Runner(f.config).open();
  const durable = JSON.parse(await runner.store.read(runner.head, "migration/index.json"));
  assert.ok(durable.bundle.manifestSha256);
  const copyRoot = path.join(f.directory, "recovered-research");
  mkdirSync(copyRoot);
  runner.root = copyRoot;
  assert.equal((await runner.restore()).installed, 2);
  assert.deepEqual(runner.status().skip, ["discover"]);
});

test("lost state push reply is acknowledged only by exact remote HEAD; unreadable result blocks then recovers", async (t) => {
  const f = await fixture(t);
  let blind = false, lose = true;
  const fault = async (cwd, args, options) => {
    if (blind && args[0] === "ls-remote" && args.includes("--exit-code")) throw new Error("Synthetic network failure");
    const result = await git(cwd, args, options);
    if (lose && args[0] === "push") { blind = true; lose = false; throw new Error("Synthetic lost acknowledgement"); }
    return result;
  };
  const runner = await new Runner(f.config, { runGit: fault }).open();
  await assert.rejects(runner.start(), (error) => error.outcome === "unknown");
  const proposal = runner.store.pending();
  assert.ok(proposal);
  await assert.rejects(new Runner(f.config).open(), /Pending/);
  blind = false;
  const recovery = await runner.recover();
  assert.equal(recovery.outcome, "acknowledged");
  assert.equal(recovery.stateCommit, proposal.commit);
  assert.equal(runner.store.pending(), null);
});

test("two local remote clients cannot both acquire; expired owner resumes without discarding checkpoint", async (t) => {
  const f = await fixture(t);
  let now = Date.now();
  const first = await new Runner(f.config, { now: () => now }).open();
  const second = await new Runner({ ...f.config, owner: "other-owner", directory: path.join(f.directory, "other-session") }).open();
  await first.start();
  await assert.rejects(second.start(), /HEAD changed/);
  await first.run(job());
  const digest = sha256(jsonBytes(first.checkpoint));
  now += first.ttlMs + 1;
  await assert.rejects(first.renew(), /expired/);
  await assert.rejects(new Runner({ ...f.config, owner: "other-owner", directory: path.join(f.directory, "third-session") })
    .open().then((runner) => runner.start()), /writer is active/);
  const generation = first.control.generation;
  await first.resume();
  assert.equal(first.control.generation, generation + 1);
  assert.equal(sha256(jsonBytes(first.checkpoint)), digest);
  assert.equal((await first.run(job())).skipped, true);
  await first.release();
  await assert.rejects(first.start(), /released run already exists/);
});

test("failed staging retains dirty research and abandoned index; next proposal uses a fresh index", async (t) => {
  const f = await fixture(t);
  let fail = false;
  const fault = async (cwd, args, options) => {
    if (fail && args[0] === "--work-tree") {
      fail = false;
      writeFileSync(`${options.env.GIT_INDEX_FILE}.lock`, "Synthetic abandoned index lock");
    }
    return git(cwd, args, options);
  };
  const runner = await started(f, { runGit: fault });
  write(f.root, "local-assets/unfinished-notes.txt", "Unsaved analysis must survive\n");
  fail = true;
  const before = runner.head;
  await assert.rejects(runner.begin(job()), /Git/);
  assert.equal(runner.store.pending(), null);
  assert.equal(await runner.store.head(), before);
  assert.equal(readFileSync(path.join(f.root, "local-assets/unfinished-notes.txt"), "utf8"), "Unsaved analysis must survive\n");
  await runner.run(job());
  assert.equal(readFileSync(path.join(f.root, "local-count"), "utf8"), "x");
  write(f.root, job().outputs[0], { unsavedRevision: true });
  await assert.rejects(runner.restore(), /hash\/length/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.root, job().outputs[0]))), { unsavedRevision: true });
});

test("heartbeat persists renewals; recovered intent validates existing output without running command again", async (t) => {
  const f = await fixture(t);
  f.config.heartbeatMs = 100;
  const runner = await started(f);
  const slow = job("slow", "discovery", 650);
  const before = Number((await git(f.remote, ["rev-list", "--count", ref])).toString());
  await runner.run(slow);
  const after = Number((await git(f.remote, ["rev-list", "--count", ref])).toString());
  assert.ok(after - before >= 5, "Intent, completion and repeated renewals were durable");
  const next = job("review", "screening");
  await runner.begin(next);
  await assert.rejects(runner.release(), /unfinished intent/);
  await execute(next.command[0], next.command.slice(1), { cwd: f.root });
  const recovered = await new Runner(f.config).open();
  await assert.rejects(recovered.run(next), /Uncertain intent/);
  await assert.rejects(recovered.reconcile({ ...next, validate: [process.execPath, "-e", "process.exit(0)"] }), /changed inputs/);
  await recovered.reconcile(next);
  assert.equal(readFileSync(path.join(f.root, "local-count"), "utf8"), "xx");
  assert.deepEqual(recovered.status().skip, ["slow", "review"]);
});

test("renewal failure terminates running child, retains output and blocks work until exact proposal is reconciled", async (t) => {
  const f = await fixture(t);
  f.config.heartbeatMs = 100;
  let pushes = 0;
  const fault = async (cwd, args, options) => {
    if (args[0] === "push" && ++pushes >= 4) throw new Error("Synthetic renewal outage");
    return git(cwd, args, options);
  };
  const runner = await started(f, { runGit: fault });
  const slow = job("slow", "discovery", 10_000);
  const start = Date.now();
  await assert.rejects(runner.run(slow), /command failed|not-applied/);
  assert.ok(Date.now() - start < 8000);
  assert.ok(existsSync(path.join(f.root, slow.outputs[0])));
  assert.ok(runner.store.pending());
  assert.equal(runner.checkpoint.units.slow.state, "intent");
  const fresh = new Runner(f.config);
  await fresh.recover({ retry: true });
  await fresh.reconcile(slow);
  assert.equal(readFileSync(path.join(f.root, "local-count"), "utf8"), "x");
});

test("a competing remote commit rejects a pending proposal without rebase, force, or research deletion", async (t) => {
  const f = await fixture(t);
  const runner = await started(f);
  await runner.store.prepare(runner.head, (payload) => {
    write(payload, "migration/example.json", { fixture: true });
    return ["migration/example.json"];
  });
  await git(f.seed, ["fetch", f.remote, ref]);
  await git(f.seed, ["reset", "--hard", "FETCH_HEAD"]);
  write(f.seed, "other.json", { fixture: "competing writer" });
  await git(f.seed, ["add", "other.json"]);
  await git(f.seed, ["commit", "-m", "Synthetic competing commit"]);
  await git(f.seed, ["push", f.remote, `HEAD:${ref}`]);
  await assert.rejects(runner.store.recover({ retry: true }), (error) => error.outcome === "conflict");
  assert.ok(runner.store.pending());
});

test("unselected output and changed source cannot be acknowledged as completed research", async (t) => {
  const f = await fixture(t);
  const runner = await started(f);
  const unit = job();
  unit.outputs = ["local-count"];
  await assert.rejects(runner.run(unit), /Every completed output/);
  assert.equal(runner.checkpoint.units.discover.state, "intent");
  write(f.root, "README.md", "changed executable context");
  await assert.rejects(runner.verifySource(), /Tracked source changed/);
});

test("session lock refuses a live process and does not erase its lock", async (t) => {
  const f = await fixture(t);
  await withSessionLock(f.config.directory, async () => {
    await assert.rejects(withSessionLock(f.config.directory, async () => {}), /locked/);
    await assert.rejects(withSessionLock(f.config.directory, async () => {}, { unlock: true }), /still exists/);
  });
  assert.equal(existsSync(path.join(f.config.directory, "runner.lock")), false);
});

async function publicationFixture(t) {
  const f = await fixture(t);
  const publicRemote = path.join(f.directory, "public.git");
  await git(f.directory, ["init", "--bare", publicRemote]);
  await git(f.root, ["push", publicRemote, `${f.base}:${ref}`]);
  const runner = await started(f);
  for (const stage of ["content", "receipt-ledger", "finalize"]) await runner.run(job(stage, stage));
  await git(f.root, ["add", "--", "content/paper-reading"]);
  await git(f.root, ["commit", "-m", "Synthetic publication"]);
  const commit = (await git(f.root, ["rev-parse", "HEAD"])).toString().trim();
  return { ...f, runner, publication: { remote: publicRemote, ref, commit } };
}

test("publication journal survives failed push, lost reply and Pages failure; exact retry never reruns research", async (t) => {
  const f = await publicationFixture(t);
  let pushes = 0, phase = "reject";
  const fault = async (cwd, args, options) => {
    if (args[0] === "push" && args[1] === f.publication.remote) {
      pushes++;
      if (phase === "reject") throw new Error("Synthetic public push outage");
      await git(cwd, args, options);
      throw new Error("Synthetic lost public reply");
    }
    return git(cwd, args, options);
  };
  const options = { runGit: fault, verify: async () => ({ commit: f.publication.commit, state: "failure" }) };
  await assert.rejects(publish(f.runner, f.publication, options), /not acknowledged/);
  assert.equal(f.runner.index.publication.events.at(-1).type, "push-not-applied");
  phase = "lose-reply";
  const pending = await publish(await new Runner(f.config).open(), f.publication, options);
  assert.equal(pending.complete, false);
  assert.equal(pending.deploymentState, "failure");
  const fresh = await new Runner(f.config).open();
  await assert.rejects(publish(fresh, f.publication, { ...options, verify: async () => ({ commit: "a".repeat(40), state: "success" }) }), /another commit/);
  const complete = await publish(await new Runner(f.config).open(), f.publication,
    { ...options, verify: async () => ({ commit: f.publication.commit, state: "success", deploymentId: 10, statusId: 20 }) });
  assert.equal(complete.complete, true);
  assert.equal(pushes, 2);
  assert.equal(readFileSync(path.join(f.root, "local-count"), "utf8"), "xxx");
  const final = await new Runner(f.config).open();
  assert.equal(final.index.publication.events.at(-1).type, "verified");
  assert.equal(final.status().skip.length, 3);
});

test("publication refuses changed public HEAD and commits containing private files", async (t) => {
  const f = await publicationFixture(t);
  await git(f.root, ["push", f.publication.remote, `${f.publication.commit}:${ref}`]);
  write(f.root, "README.md", "Synthetic unrelated public head");
  await git(f.root, ["add", "README.md"]);
  await git(f.root, ["commit", "-m", "Synthetic newer public commit"]);
  await git(f.root, ["push", f.publication.remote, `HEAD:${ref}`]);
  // Restore source bytes without changing the newer remote commit.
  write(f.root, "README.md", "Synthetic test source\n");
  await assert.rejects(publish(f.runner, f.publication), /base changed/);
  const privateCommit = (await git(f.root, ["rev-parse", "HEAD"])).toString().trim();
  await assert.rejects(publish(f.runner, { ...f.publication, commit: privateCommit }), /single commit/);
});

test("publication rejects a direct child commit containing private run artifacts", async (t) => {
  const f = await publicationFixture(t);
  write(f.root, "local-assets/private-test.json", { synthetic: "must remain private" });
  await git(f.root, ["add", "--force", "--", "local-assets/private-test.json"]);
  await git(f.root, ["commit", "--amend", "--no-edit"]);
  const commit = (await git(f.root, ["rev-parse", "HEAD"])).toString().trim();
  // The public-data allowlist rejects the private file, even with valid parentage.
  await assert.rejects(publish(f.runner, { ...f.publication, commit }), /Tracked source changed|allowlisted public/);
  assert.equal((await git(f.publication.remote, ["rev-parse", ref])).toString().trim(), f.base);
});

test("Git attribute normalization cannot silently change exported artifact bytes", async (t) => {
  const f = await fixture(t);
  write(f.seed, ".gitattributes", "*.json text eol=lf\n");
  await git(f.seed, ["add", ".gitattributes"]);
  await git(f.seed, ["commit", "-m", "Synthetic state attribute rule"]);
  await git(f.seed, ["push", f.remote, `HEAD:${ref}`]);
  f.config.expectedStateCommit = (await git(f.seed, ["rev-parse", "HEAD"])).toString().trim();
  write(f.root, "content/paper-reading/state/discovery-state.json", "{\r\n  \"fixture\": true\r\n}\r\n");
  const runner = await new Runner(f.config).open();
  await assert.rejects(runner.start(), /staging changed artifact bytes/);
  assert.equal(await runner.store.head(), f.config.expectedStateCommit);
});

test("GitHub Pages verifier reads exact latest deployment/status, rejects other SHA and reports API denial", async () => {
  const commit = "b".repeat(40);
  const remote = "https://github.com/example/synthetic.git";
  const calls = [];
  const mock = (deployments, statuses) => async (url) => {
    calls.push(url);
    return { ok: true, json: async () => url.includes("/statuses?") ? statuses : deployments };
  };
  const deployments = [{ id: 9, environment: "github-pages", sha: commit }, { id: 10, environment: "github-pages", sha: commit }];
  const result = await verifyGitHubPages({ remote, commit, fetchImpl: mock(deployments, [{ id: 22, state: "success" }, { id: 21, state: "failure" }]) });
  assert.equal(result.state, "success");
  assert.equal(result.deploymentId, 10);
  assert.ok(calls.every((url) => url.startsWith("https://api.github.com/repos/example/synthetic/")));
  await assert.rejects(verifyGitHubPages({ remote, commit, fetchImpl: mock([...deployments, { id: 11, environment: "github-pages", sha: "c".repeat(40) }], []) }), /another commit/);
  await assert.rejects(verifyGitHubPages({ remote, commit, fetchImpl: async () => ({ ok: false, status: 403 }) }), /HTTP 403/);
  const failure = await verifyGitHubPages({ remote, commit, fetchImpl: mock(deployments, [{ id: 23, state: "failure" }]) });
  assert.equal(failure.state, "failure");
});

test("transport accepts explicit GitHub URLs but rejects credential URLs and implicit/unsafe refs", () => {
  assert.doesNotThrow(() => validateRemote("https://github.com/example/synthetic.git", ref));
  for (const remote of ["https://name:secret@github.com/example/synthetic.git", "ssh://github.com/example/synthetic", "https://example.invalid/repo", "https://github.com/example/repo?token=test"]) {
    assert.throws(() => validateRemote(remote, ref));
  }
  assert.throws(() => validateRemote("https://github.com/example/repo", "main"));
  assert.throws(() => validateRemote("https://github.com/example/repo", "refs/heads/../main"));
  assert.equal(typeof GitStore, "function");
});
