import { COMMIT, jsonBytes, sha256 } from "./files.mjs";
import { GitStore, validateRemote } from "./git-store.mjs";
import { artifactRole } from "./state.mjs";
import { publicationPlan } from "./checkpoints.mjs";

// GET only. Uses an existing token if supplied by the environment, otherwise the
// public API. No credential creation, login, deployment or workflow dispatch.
export async function verifyGitHubPages({ remote, commit, fetchImpl = fetch }) {
  validateRemote(remote, "refs/heads/validation");
  if (!remote.startsWith("https://github.com/") || !COMMIT.test(commit)) throw new Error("GitHub Pages verification requires a GitHub remote and exact commit.");
  const repository = new URL(remote).pathname.replace(/^\//, "").replace(/\.git$/, "");
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10",
    ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const get = async (resource) => {
    let response;
    try {
      response = await fetchImpl(`https://api.github.com/repos/${repository}/${resource}`,
        { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
    } catch { throw new Error("Deployment API unavailable; publication remains unverified. Check the authorized network policy."); }
    if (!response.ok) throw new Error(`Deployment API HTTP ${response.status}; publication remains unverified.`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error("Invalid deployment API response.");
    return data;
  };
  // Examine the latest environment deployment, not a historical successful
  // deployment of this SHA that may already have been superseded.
  const deployments = await get("deployments?environment=github-pages&per_page=100");
  const latest = deployments.filter((entry) => entry.environment === "github-pages" && Number.isSafeInteger(entry.id))
    .sort((a, b) => b.id - a.id)[0];
  if (!latest) return { commit, state: "pending", reason: "no-deployment" };
  if (latest.sha !== commit) throw new Error("Latest Pages deployment is for another commit.");
  const statuses = await get(`deployments/${latest.id}/statuses?per_page=100`);
  const status = statuses.filter((entry) => Number.isSafeInteger(entry.id)).sort((a, b) => b.id - a.id)[0];
  const state = status?.state ?? "pending";
  if (!["pending", "queued", "in_progress", "success", "failure", "error", "inactive"].includes(state)) throw new Error("Unknown deployment status.");
  return { commit: latest.sha, environment: "github-pages", deploymentId: latest.id,
    statusId: status?.id ?? null, state };
}

export async function publish(runner, { remote, ref, commit }, {
  verify = verifyGitHubPages, runGit = runner.store.git,
} = {}) {
  validateRemote(remote, ref);
  if (!COMMIT.test(commit)) throw new Error("Exact publication commit required.");
  await runner.renew();
  await runner.verifySource();
  const target = new GitStore({ remote, ref, directory: runner.store.directory, runGit });
  await target.init();
  const base = runner.checkpoint.context.repositoryBaseCommit;
  const existing = runner.index.publication;
  if (existing && (existing.remote !== remote || existing.ref !== ref || existing.commit !== commit || existing.base !== base)) {
    throw new Error("Publication journal pins a different target or commit.");
  }
  // A single publication commit contains only selected public data. Intermediate
  // commits cannot smuggle private artifacts into the pushed history.
  const parents = (await runGit(runner.root, ["rev-list", "--parents", "-n", "1", commit])).toString().trim().split(" ");
  if (parents.length !== 2 || parents[1] !== base) throw new Error("Publication must be a single commit directly on the frozen public base.");
  const paths = (await runGit(runner.root, ["diff-tree", "--no-commit-id", "--name-only", "-r", base, commit])).toString().trim().split("\n").filter(Boolean);
  if (!paths.length || paths.some((file) => !file.startsWith("content/paper-reading/") || !artifactRole(file))) {
    throw new Error("Publication commit may change only allowlisted public paper-reading data.");
  }
  await runGit(runner.root, ["diff", "--exit-code", commit, "--", "content/paper-reading"]);
  if ((await runGit(runner.root, ["ls-files", "--others", "--exclude-standard", "--", "content/paper-reading"])).length) {
    throw new Error("Uncommitted public data is missing from the publication commit.");
  }
  let journal = existing ?? { schemaVersion: 1, remote, ref, commit, base,
    checkpointSha256: sha256(jsonBytes(runner.checkpoint)), events: [] };
  if (journal.checkpointSha256 !== sha256(jsonBytes(runner.checkpoint))) throw new Error("Publication checkpoint changed.");
  const event = async (type, details = {}) => {
    journal = { ...journal, events: [...journal.events, { type, at: new Date(runner.now()).toISOString(), commit, ...details }] };
    await runner.journal(journal);
  };
  const preflight = async (publicHead, verifiedCommit = null) => {
    await runner.current();
    return publicationPlan({ checkpoint: runner.checkpoint, root: runner.root, control: runner.control,
      lease: runner.session.lease, now: runner.now(), publicHead, publicCommit: commit,
      pushedCommit: publicHead === commit ? commit : null, verifiedCommit,
      durableState: { commit: runner.head, checkpointSha256: journal.checkpointSha256 },
      observedStateCommit: await runner.store.head(), expectedCheckpoint: journal.checkpointSha256 });
  };
  let publicHead = await target.head();
  await preflight(publicHead);
  if (!existing) await event("prepared", { stateCommit: runner.head });
  if (publicHead !== commit) {
    if (journal.events.some((entry) => entry.type === "push-acknowledged")) throw new Error("Previously acknowledged public commit disappeared; stop.");
    // Intent survives a crash before, during or after the external push.
    await event("push-intent");
    await preflight(await target.head());
    try { await runGit(runner.root, ["push", remote, `${commit}:${ref}`]); }
    catch { /* Reconcile a possibly accepted push below. */ }
    try { publicHead = await target.head(); } catch {
      await event("push-unknown");
      throw new Error("Public push outcome unknown; resume publish to read back the exact commit.");
    }
    if (publicHead !== commit) {
      await event(publicHead === base ? "push-not-applied" : "push-conflict");
      throw new Error("Public commit was not acknowledged; research is complete, resume publication only.");
    }
  }
  if (!journal.events.some((entry) => entry.type === "push-acknowledged")) await event("push-acknowledged");
  await preflight(publicHead);
  let verification;
  try {
    verification = await verify({ remote, commit });
    if (verification.commit !== commit) throw new Error("Deployment verification is for another commit.");
    if (verification.state !== "success") {
      await event("verify-pending", { deploymentState: verification.state });
      return { complete: false, commit, deploymentState: verification.state, stateCommit: runner.head };
    }
    await preflight(await target.head(), verification.commit);
  } catch (error) {
    await event("verify-error");
    throw error;
  }
  // Persist only the bounded evidence fields, never a raw provider response.
  await event("verified", { deploymentId: verification.deploymentId ?? null, statusId: verification.statusId ?? null });
  return { complete: true, commit, stateCommit: runner.head };
}
