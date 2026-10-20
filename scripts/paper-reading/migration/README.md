# Portable paper-reading state (local preparation)

These modules prepare a migration; they do not deploy or schedule it. No command
here performs research, logs in, reads credentials, uploads data, or pushes to a
network remote. The production pipeline is not wired to the new coordination
protocol yet. The only changes to existing pipeline behavior are the historical
schema reconstruction and non-daily finalization status fixes.

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

The API returns new values and local checkpoint files. The caller must implement
the remote acknowledgement sequence; it is not implicitly performed by
`saveCheckpoint`. There is deliberately no general command runner or research
callback in this preparation.

This prevents automatic repeats after a durable completion. It does not promise
exactly-once execution across a crash between an external action and its durable
completion acknowledgement. Such cases remain uncertain until reconciled.
Daily finalize is an idempotent pipeline operation; the new checkpoint protocol
also rejects a finalize unit for backfill, updates, or conference modes.

## Single writer and publication order

`lease.mjs` defines owner, run ID, random fencing token, generation and expiry.
All daily/backfill/updates/conference/manual writers must adopt this protocol.
Expiry never authorizes takeover. The known owner explicitly releases; an
unreachable owner needs an independently verified job termination and a separately
reviewed recovery procedure. No automatic forced takeover is implemented.

Before every state mutation, renew/check the current owner and fencing token.
Checkpoint pins must advance one sequence at a time from the acknowledged parent.
Build a single-parent commit from the observed state HEAD and use ordinary
fast-forward push. A competing writer must stop on rejection. Never force-push,
merge or rebase a losing lease proposal.

`commitControlLocal` is a **synthetic-test transport** that accepts only an absolute
filesystem path to a bare Git repository. Tests use two clones of that local
remote. There is no GitHub CAS transport or credentials plumbing in this patch.
A real transport must also persist checkpoint/bundle files in the acknowledged
commit, refresh the remote HEAD before each mutation, verify the token, and handle
uncertain push results by reading the exact remote commit before retrying.

`publicationPlan` is a fail-closed preflight, not a publisher. It checks output
proofs, no unresolved intents, verified content/receipt-ledger (and daily finalize),
an acknowledged private state commit, the original public base, and an exact public
commit. Persist audit state first, then publish canonical/digest/receipt/ledger/
watermark together. A failed push or Pages check resumes publication only.
Neither a receipt's `recordedAsPublished` flag nor a successful build proves that
the exact commit was deployed.

The public repository and private state repository are separate transactions.
The final production runner must retain a publication journal and reconcile
uncertain outcomes; the local preflight is not an atomic cross-repository commit.

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

The preparation directory also has `run-tests.mjs` to run the selected existing
ledger/cache/screening/radar/conference suites with a minimal environment and
synthetic temporary directories. Production canonical fixtures are not copied
into tests. This validates local primitives and compatibility, not a cloud
executor, GitHub transport, API/ChatGPT authentication, or live Pages deployment.

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
