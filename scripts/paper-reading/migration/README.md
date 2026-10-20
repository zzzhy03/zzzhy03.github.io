# Portable paper-reading state and explicit runner

The export/restore CLI remains local. The separate `runner.mjs` entrypoint can
persist state to an explicitly selected GitHub HTTPS branch, execute approved
pipeline commands with checkpoints and lease renewal, and resume publication.
It is opt-in: this change does not alter schedules, deploy the site, or make
existing direct pipeline invocations participate in the lease protocol.

Use the runner only after authorizing its exact state repository/ref and any
publication repository/ref. Its local configuration and session directory are
private machine state and must stay outside the source tree. It uses the existing
Git credential helper and platform proxy without logging in or creating tokens.

## Export and restore

Use Node 22.13 or newer. No additional npm dependency is required.

```sh
node scripts/paper-reading/migration/cli.mjs inventory --root /path/to/checkout
node scripts/paper-reading/migration/cli.mjs export --root /path/to/checkout --destination /path/to/new-bundle --context /path/to/context.json
node scripts/paper-reading/migration/cli.mjs restore --bundle /path/to/new-bundle --target /path/to/isolated-checkout --manifest-sha256 PINNED_SHA256 --context /path/to/context.json
```

`context.json` has exactly these fields:

```json
{
  "repositoryBaseCommit": "FULL_GIT_COMMIT",
  "codeSnapshotSha256": "SHA256_OF_REVIEWED_SOURCE_SNAPSHOT"
}
```

The caller must independently verify the checkout commit and reviewed source
snapshot. A context string alone is not proof that the executor is running those
bytes. A dirty production working tree must not be represented as a clean HEAD.

The bundle is `manifest.json` plus `files/<original repository-relative path>`.
The manifest pins each file's role, length and SHA-256. It is created only after
all allowlisted files pass preflight, and the source set is rechecked before the
staged bundle is renamed into place. Export refuses an existing destination or
a destination inside its source tree.

Save the returned manifest hash in a trusted state index at a pinned Git commit.
Restore requires this independently obtained hash and exact expected context;
hashes inside an untrusted manifest alone do not establish provenance.

Restore validates the complete package before installing anything. It rejects
path traversal, absolute paths, symlinks, duplicate/unmanifested files, unknown
bundle schemas/roles, wrong run IDs, modified lengths/hashes, and credential-shaped
data. Existing target files must already match. Only missing files are installed,
with atomic no-overwrite file installation. An interrupted installation can be
replayed; it never silently overwrites a conflicting canonical or state file.
This is a series of atomic file installations, not a filesystem-wide transaction.
Use an exclusively owned checkout and hold the writer lease before use.

## Selected data and exclusions

Allowed:

- `content/paper-reading/{topics,research-config,venue-registry,pipeline-config}.json`
- `content/paper-reading/state/{discovery-state,decision-ledger}.json`
- `content/paper-reading/{papers,digests,runs}/*.json`
- `local-assets/paper-reading/runs/<run>/manifest.json`, `candidates.json`
- The run's screening manifest, ledger input, `batches/*.input.json`,
  and `reviews/*.review.json`
- The run's `fulltext/reviews/*.json`, `fulltext/{summary,backlog,source-cache}.json`,
  and `decision-ledger/delta.json`
- Small HTML/TXT/JSON withdrawal notices explicitly pinned by a selected receipt

Every selected file retains all original fields and bytes, including review
text, reviewer labels, source URLs and any historical local path strings.
Rewriting those fields would invalidate audit hashes. This is private state.
The scanner reports file names and hashes, and suppresses matched secret values.
It excludes auth/config stores by scope and applies credential-key/prefix/URL
checks to selected data. It cannot guarantee that arbitrary prose has no secret;
review the exact local upload inventory before authorizing a transfer.

Not selected: PDFs, extracted full text, renders, unknown source evidence,
invocation baselines, audit/verification/publication logs, `.env` or authentication
files, dependency/build directories, and unrelated work. Historical evidence
outside the allowlist stays in the local archive. This is not a forensic backup.

Completed PDF removals must remain verifiable through original source-cache and
receipt bytes. For an unfinished review that needs an absent PDF, download only
the pinned exact version and verify its original SHA-256; otherwise stop.
No component here downloads a PDF or claims to have reread it. A separate private
binary store would require a separate decision if exact re-download is impossible.

## Checkpoints and duplicate work

`checkpoints.mjs` provides immutable, hash-pinned checkpoint versions. A run freezes
run ID, mode, time window, source base commit, code hash and policy fingerprint.
Each work unit has a stable ID (for example `screening:batch-001`), input hash,
explicit dependencies, and an `intent` or `complete` state.

Required execution order:

1. Save the initial checkpoint and acknowledge its pin in the durable control
   commit under the active lease.
2. `beginUnit`, `saveCheckpoint`, and acknowledge the new checkpoint in a control
   CAS commit **before** starting work.
3. Perform the unit in an isolated checkout; persist its allowlisted output bytes.
4. `completeUnit` verifies output hashes. Save/acknowledge that checkpoint and its
   output bundle before starting another unit.
5. On recovery, load the pinned checkpoint and use `resumePlan`. Verified complete
   units are skipped. An outstanding intent is uncertain and requires explicit
   reconciliation with existing output; it is not automatically executed again.

The primitive API still returns local values/files. `runner.mjs` implements the
remote acknowledgement sequence around these primitives. `run` executes an argv
without a shell, then a required validator; `begin` and `reconcile` support
analysis authored by the current Codex task. No additional model API is used.

This prevents automatic repeats after a durable completion. It does not promise
exactly-once execution across a crash between an external action and its durable
completion acknowledgement. Such cases remain uncertain until reconciled.
Daily finalize is an idempotent pipeline operation; the new checkpoint protocol
also rejects a finalize unit for backfill, updates, or conference modes.

## Single writer and publication order

`lease.mjs` defines owner, run ID, random fencing token, generation and expiry.
All daily/backfill/updates/conference/manual writers must adopt this protocol.
Expiry never authorizes takeover. The known owner explicitly releases; a new
executor uses `adopt` only after an operator explicitly confirms the exact old
execution has ended. A missing session, a different host, or possession of the
old token is not termination evidence. Unattended recovery without that
confirmation stops. No automatic forced takeover is implemented.

Before every state mutation, renew/check the current owner and fencing token.
Checkpoint pins must advance one sequence at a time from the acknowledged parent.
Build a single-parent commit from the observed state HEAD and use ordinary
fast-forward push. A competing writer must stop on rejection. Never force-push,
merge or rebase a losing lease proposal.

`commitControlLocal` remains a synthetic fixture helper. `git-store.mjs` is the
runtime transport: it accepts credential-free GitHub HTTPS URLs or local bare
repositories, requires an existing explicit branch, builds single-parent commits,
and uses ordinary fast-forward pushes. It rejects URL rewriting. Checkpoint,
bundle and control are in the same commit; an independent remote HEAD read is
required before work. An uncertain result retains the exact proposal locally.
After exact acknowledgement, the runner reads that commit's existing local
objects without fetching them again. A fresh session still fetches the remote,
and later actions check HEAD again. Git failures expose only a bounded category,
exit/signal and any HTTP status; raw credential-bearing diagnostics stay hidden.

`publicationPlan` is a fail-closed preflight, not a publisher. It checks output
proofs, no unresolved intents, verified content/receipt-ledger (and daily finalize),
an acknowledged private state commit, the original public base, and an exact public
commit. Persist audit state first, then publish canonical/digest/receipt/ledger/
watermark together. A failed push or Pages check resumes publication only.
Neither a receipt's `recordedAsPublished` flag nor a successful build proves that
the exact commit was deployed.

The public repository and private state repository are separate transactions.
`publication.mjs` persists a journal before pushing, reconciles the exact public
HEAD after any push result, and records deployment verification. It never treats
these operations as one atomic transaction.

## Runner configuration and execution

Keep `runner-config.json` outside the source tree. All values below are
placeholders; no repository or branch is selected implicitly:

```json
{
  "root": "research-checkout",
  "directory": "private-runner-session",
  "remote": "https://github.com/OWNER/PRIVATE_STATE_REPO.git",
  "ref": "refs/heads/APPROVED_STATE_BRANCH",
  "owner": "unique-cloud-execution-id",
  "ttlMs": 300000,
  "context": {
    "runId": "RUN_ID",
    "mode": "daily",
    "window": {"start": "ISO_START", "end": "ISO_END"},
    "repositoryBaseCommit": "FULL_PUBLIC_BASE_COMMIT",
    "codeSnapshotSha256": "SHA256_OF_GIT_ARCHIVE_TAR_AT_BASE",
    "policyFingerprint": "sha256:POLICY_HASH"
  }
}
```

Resolve paths relative to the invoking process. The research checkout and session
directory must be separate, exclusively owned directories. `start` checks the
reviewed source archive and rejects tracked changes outside paper-reading data.
Untracked executable inputs are the caller's responsibility; list their hashes in
the unit's `inputs`. It is not a sandbox for untrusted commands.

For the first installation only, supply `initializeFromRoot: true` and
`expectedStateCommit` equal to the independently verified state branch HEAD.
Review the export inventory first. This adds the `migration/` namespace and
preserves legacy bundle files. Later starts restore the acknowledged bundle and
refuse conflicting local files. Existing state is never silently replaced.

```sh
npm run migrate:papers -- start runner-config.json
npm run migrate:papers -- run runner-config.json unit.json
npm run migrate:papers -- status runner-config.json
```

A unit is a stable input/output contract, for example:

```json
{
  "id": "screening:batch-001",
  "stage": "screening",
  "dependencies": ["discovery"],
  "inputs": [{"path": "RELATIVE_INPUT", "bytes": 123, "sha256": "INPUT_HASH"}],
  "outputs": ["RELATIVE_ALLOWLISTED_OUTPUT"],
  "command": ["node", "APPROVED_SCRIPT", "APPROVED_ARGUMENT"],
  "validate": ["node", "READ_ONLY_VALIDATOR", "APPROVED_ARGUMENT"]
}
```

Use the existing discovery, screening, fulltext and pipeline scripts as appropriate
for each unit. Inputs, command, validator and output paths are hashed into the
contract. New units also save the complete portable contract under
`migration/contracts/`, pinned by hash/length in the index, in the intent commit.
Use `node` (the current Node executable is normalized to it), other installed
command names, and checkout-relative paths. Absolute machine paths and credential
arguments are rejected; credentials remain in the authorized environment.
Embedded programs must also be portable. Task-authored units can supply bounded
`instructions`; these are also persisted and included in the contract hash.
Restoring a contract never executes it.
The output files and full current selected state are exported with the completion
checkpoint. Excluded PDFs/extracted text
cannot serve as the only durable output proof. Validators retain responsibility
for domain/schema correctness; a successful arbitrary command is not scientific
validation.

During `run`, renewal occurs every third of the lease duration by default. A
renewal failure, expiry or interrupt stops the command process group and leaves
its intent uncertain. Commands must not daemonize or escape that process group.
Research output stays on disk. For task-authored analysis use `begin`, author the
review, call `renew` before the lease expires, then `reconcile` with the same unit
specification. `reconcile` runs only its validator. Do not let a long analysis turn
outlive its lease; pause and explicitly recover if it does.

## Recovery without resetting research

The transport uses a bare object cache and a fresh index for every proposal.
It does not stage, reset, clean, rebase or force-push the research checkout.
Abandoned staging directories remain under `transport/proposals/`; the next
proposal uses a fresh index. Local directories are disposable caches, not the
durable identity or recovery authority. Keeping them permits exact local proposal
retry and preserves unpushed work, but is not required for recovery from a remote
checkpoint. `session.json` holds a lease token, not a GitHub token.

1. If a CLI was killed, use `unlock` only after it exits. This checks the recorded
   same-host PID is absent; a live or unverifiable process retains its lock.
2. Run `recover` to read the remote. Exact proposal HEAD acknowledges the commit.
   An unavailable remote remains unknown; another HEAD is a conflict and stops.
3. If the remote still equals the proposal's parent, `retry` explicitly pushes
   the **same** proposal and checks HEAD again. It never reconstructs or rebases it.
4. `restore` installs only missing matching state into the configured isolated
   root. Conflicting unsaved files remain untouched. Preserve that root and
   restore into a fresh code checkout if needed; inspect/copy unfinished output
   deliberately, then use the original unit contract's `reconcile`.
5. `status` identifies completed and uncertain units. Re-running a completed
   contract skips it; re-running an uncertain one stops before its command.
6. After independently confirming the previous worker is stopped, the original
   owner may explicitly `resume CONFIG ENDED_CONFIRMATION`, including after
   expiry, using the same confirmation fields as `adopt` below. This fences the old
   generation while preserving the checkpoint and publication journal. It is not
   automatic expiry takeover. A different owner cannot resume or release it.
7. Use `release` after finishing a run that does not publish. A successful
   `publish` now releases automatically, pushes that release, and independently
   reads back its exact remote commit before returning `complete: true`,
   `released: true`, `disposable: true`. A failed/unknown release is not success.
   A later fresh `recover` can observe an already accepted release; `release`
   then reports it idempotently. Normal subsequent runs use new run/owner IDs.

A conflicting CAS requires inspecting the other writer, not deleting the pending
proposal or force-pushing it. Git acknowledgements do not provide exactly-once
semantics for arbitrary external side effects. Any uncertain external action
still needs independent reconciliation.

## Entire executor lost: remote recovery and its limits

Every daily execution may use fresh source/state clones and fresh temporary
directories. No session, pending proposal file, Git object cache, local PID lock,
or old filesystem is copied into the next executor.

For recovery, configure only `root`, `directory`, the approved private
`remote/ref`, and a new unique execution `owner`. Omit `context` to discover the
frozen run from the remote checkpoint. `inspect` reports the source commit,
context, previous owner/generation and state commit without exposing its token.
Prepare a fresh checkout of that exact reviewed source commit, then `recover`
restores the acknowledged state. Proven clean tracked source-baseline data may
be updated to the newer private bundle; other conflicting local data is never
overwritten. This permits restoring changed aggregates before publication.

```sh
npm run migrate:papers -- inspect fresh-config.json
# Clone the source and select the reported exact source commit in the new root.
npm run migrate:papers -- recover fresh-config.json
```

An active lease, including an expired one, blocks work until explicit handoff.
The operator must independently confirm the previous execution and all its
children have ended, then supply this bounded record:

```json
{
  "previousInstanceEnded": true,
  "expectedStateCommit": "EXACT_INSPECTED_STATE_COMMIT",
  "previousOwner": "OLD_EXECUTION_ID",
  "previousRunId": "FROZEN_RUN_ID",
  "previousGeneration": 1,
  "confirmedBy": "OPERATOR_ID",
  "reason": "Describe the independently checked execution termination."
}
```

```sh
npm run migrate:papers -- adopt fresh-config.json ended-confirmation.json
npm run migrate:papers -- run-unit fresh-config.json ACKNOWLEDGED_UNIT_ID
npm run migrate:papers -- reconcile-unit fresh-config.json UNCERTAIN_UNIT_ID
npm run migrate:papers -- publish fresh-config.json
```

`adopt` validates every old identity field and exact remote HEAD, preserves the
frozen run/checkpoint/publication journal, creates a new owner token and increments
the generation, then commits with ordinary fast-forward CAS and reads back the
exact result. Only after that acknowledgement may the new executor work.
The confirmation is recorded in control history. This is an operator assertion,
not an automatic scheduler/liveness check. Without a verifiable termination
decision, report a blocked handoff; do not invent evidence or copy the old token.
Revived old runners fail their state/lease checks and cannot retry stale private
proposals. An already in-flight arbitrary external action is why termination and
side-effect reconciliation remain required.

If a private push was accepted but its reply and the whole executor were lost,
the next clone sees the accepted checkpoint and skips complete units. If it was
not accepted, only the preceding checkpoint survives. A durable `intent` remains
uncertain, not complete. Local-only outputs, draft analyses, excluded PDFs and
unpublished local commits that were never saved remotely cannot be recovered.
Do not claim that reconstructing a local cache restores such work.

An uncertain unit with lost output needs explicit recomputation approval and
reconciliation of any external effects. Supply `expectedStateCommit`, `unitId`,
`confirmRecompute: true`, `sideEffectsReconciled: true`, `confirmedBy`, and `reason`:

```sh
npm run migrate:papers -- recompute fresh-config.json recompute-decision.json
```

The decision is committed before executing the saved contract. The result says
`recomputed: true, uncommittedWorkRestored: false`. Task-authored analysis has no
command: this authorizes re-authoring, followed by `renew` and `reconcile-unit`.
Inputs must still match their saved hashes; missing rebuildable inputs require
explicit preparation. Nothing is automatically rerun during `recover` or `adopt`.
Legacy digest-only intents without a saved contract still require the original
reviewed unit specification; commands cannot be reconstructed from a digest.

Before any public push, the exact publication commit's additional Git objects
are saved as a pinned private `migration/publications/<sha>.pack` alongside its
journal. A fresh clone imports those objects, validates the same allowlisted
single-parent candidate with a disposable index, then reads the public HEAD.
An accepted public push is verified without repushing; an unaccepted one retries
the exact saved SHA. No research index is rewritten. Legacy journals lacking a
pack cannot promise recovery of a candidate that exists nowhere remotely.

The guarantee is recovery of remotely saved checkpoints, contracts and prepared
publication objects, with explicit handoff/recomputation when required. It is
not exactly-once arbitrary side effects, recovery of never-pushed work, or
unattended proof that a missing executor has terminated.

## Publication and deployment evidence

`publish` takes a local JSON file with `remote`, full branch `ref`, and exact
`commit`. The commit must have the frozen public base as its single parent and
change only allowlisted `content/paper-reading/` files. Current public data must
match that commit; the runner does not auto-stage files or create public commits.
Content, receipt/ledger, and daily finalization units must already be acknowledged.

The journal is in the state index and its Git history. It records preparation,
push intent, acknowledgement or uncertainty, and deployment checks. After push
failure or deployment failure, repeat `publish` with the same target/commit.
An already observed exact commit is not pushed again and research is not repeated.
A changed public HEAD or wrong deployment SHA stops verification.

The default verifier performs read-only GitHub REST requests for the latest
`github-pages` environment deployment and its latest status. It requires that
deployment's exact SHA and `success`, then rechecks public HEAD. This follows the
[deployment API](https://docs.github.com/en/rest/deployments/deployments#list-deployments)
and [status API](https://docs.github.com/en/rest/deployments/statuses#list-deployment-statuses).
It uses an existing `GH_TOKEN`/`GITHUB_TOKEN` if present, otherwise public read
access. It never fetches credentials from a new source or dispatches a workflow.
The authorized network policy must also permit `api.github.com`; a denial or
unavailable API leaves publication unverified. Deployment status is provider
evidence, not a browser/content smoke test of the served site.

## Compatibility changes

Historical schema 2 is used only for the two recognized legacy run IDs, when a
verified legacy receipt pins a complete, unchanged schema-2 review set. Current
new runs retain the existing default. Unknown provenance, modified hashes, extra
reviews or schema inconsistencies fail. Original receipt/delta bytes are untouched.

Non-daily modes report watermark finalization as `not-applicable`; once receipt
and ledger are complete, status points to publication. `runFinalize` still refuses
to move the daily watermark for those modes.

## Local verification

```sh
node --test scripts/paper-reading/migration/tests/*.test.mjs
```

The migration tests include the real CLI across processes, local Git remotes,
writer conflicts, dropped acknowledgements, interrupted execution, renewal
failure, retained dirty output, restoration and publication recovery. The
deployment API is mocked. No live GitHub state branch or Pages deployment is
created by these tests; live write permissions and provider behavior require
separately approved remote acceptance.

## Cloud network startup

The parent task reported a successful cloud probe: the arXiv API returned HTTP
200 with valid Atom, and a PDF Range request returned HTTP 206 with the expected
header. In that environment, a default Node `fetch` failed with `EAI_AGAIN`,
while the same process started with `NODE_USE_ENV_PROXY=1` succeeded through the
platform-provided proxy. This is a received cloud result, not a Mac network test
or proof of end-to-end research/authentication readiness.

For an approved cloud entrypoint that needs network access, use a process-scoped
prefix:

```text
NODE_USE_ENV_PROXY=1 node <approved-entrypoint> <approved-arguments>
```

Keep the platform's existing `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` settings.
Do not print or persist their values, substitute another proxy, alter network
policy, or disable TLS verification. Do not set this globally in shell profiles,
the user's Mac environment, or unrelated tasks. Local export/restore and the
synthetic test suite need no network and do not enable it.

The environment variable is supported from Node 24.0.0 and 22.21.0 according to
the [official Node CLI documentation](https://nodejs.org/api/cli.html#node_use_env_proxy1).
The earlier minimum of 22.13 applies to the local modules; a cloud process relying
on this proxy feature needs a supported runtime, for example Node 24.x.
Check the target runtime version and use its approved network configuration.
A network probe does not authorize real-state transfer, research, or publication.
