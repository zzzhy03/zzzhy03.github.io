#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { discoverArxiv } from "./adapters/arxiv.mjs";
import { discoverOfficialReports } from "./adapters/official-reports.mjs";
import { discoverOpenReview } from "./adapters/openreview.mjs";
import { discoverVenueProceedings } from "./adapters/venue-proceedings.mjs";
import {
  buildCanonicalIndex,
  matchCanonicalCandidates,
  mergeSourceDuplicates,
} from "./lib/dedupe.mjs";
import {
  readJson,
  readJsonDirectory,
  readJsonIfPresent,
  writeJsonAtomic,
} from "./lib/io.mjs";
import { computeDiscoveryWindow } from "./lib/window.mjs";

const SOURCE_IDS = [
  "arxiv",
  "openreview",
  "venue-proceedings",
  "official-reports",
];

function parseNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number.`);
  return parsed;
}

export function parseArguments(argv) {
  const options = {
    sources: [...SOURCE_IDS],
    topicIds: null,
    recordSuccess: false,
    writeOutputs: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${argument} requires a value.`);
      return argv[index];
    };

    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--since") options.since = next();
    else if (argument === "--now") options.now = next();
    else if (argument === "--overlap-hours") {
      options.overlapHours = parseNumber(next(), "--overlap-hours");
    } else if (argument === "--source") {
      options.sources = next()
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (argument === "--topic") {
      options.topicIds = next()
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (argument === "--fixture-arxiv") options.fixtureArxiv = next();
    else if (argument === "--state-file") options.stateFile = next();
    else if (argument === "--output-root") options.outputRoot = next();
    else if (argument === "--content-root") options.contentRoot = next();
    else if (argument === "--run-id") options.runId = next();
    else if (argument === "--page-size") {
      options.pageSize = parseNumber(next(), "--page-size");
    } else if (argument === "--max-results-per-topic") {
      options.maxResultsPerTopic = parseNumber(next(), "--max-results-per-topic");
    } else if (argument === "--request-delay-ms") {
      options.requestDelayMs = parseNumber(next(), "--request-delay-ms");
    } else if (argument === "--record-success") options.recordSuccess = true;
    else if (argument === "--no-write") options.writeOutputs = false;
    else throw new Error(`Unknown argument: ${argument}`);
  }

  for (const source of options.sources) {
    if (!SOURCE_IDS.includes(source)) {
      throw new Error(`Unknown source '${source}'. Expected one of: ${SOURCE_IDS.join(", ")}.`);
    }
  }
  return options;
}

function helpText() {
  return `Paper Reading discovery staging (always non-publishing)

Usage:
  npm run discover:papers -- --since <ISO timestamp> [options]
  npm run discover:papers -- [options]  # after a successful watermark exists

Options:
  --since <ISO>                  Explicit first/manual window start; no overlap is subtracted.
  --now <ISO>                    Deterministic inclusive window end (default: current time).
  --overlap-hours <number>       Overlap before lastSuccessfulRunAt (default: state or 48).
  --source <ids>                 Comma-separated sources (default: all registered adapters).
  --topic <ids>                  Comma-separated research direction IDs.
  --fixture-arxiv <file>         Parse an Atom fixture without network requests.
  --state-file <file>            Discovery watermark JSON path.
  --output-root <directory>      Run archive root (default: local-assets/paper-reading/runs).
  --page-size <number>           arXiv page size, clamped to 1..200 (default: 100).
  --max-results-per-topic <n>    Safety cap per arXiv direction (default: 300).
  --request-delay-ms <number>    arXiv delay, clamped to at least 3100 ms.
  --record-success               Low-level compatibility flag; standard daily runs use pipeline finalize.
  --run-id <id>                  Deterministic output directory name.
  --no-write                     Return results without writing staging files.
  --help                         Show this help.

This command never writes canonical papers or digests and never publishes the site.`;
}

function defaultState() {
  return {
    schemaVersion: 1,
    lastSuccessfulRunAt: null,
    lastRunId: null,
    lastManifestPath: null,
    overlapHours: 48,
  };
}

function runIdFor(now) {
  return `discovery-${now.replace(/[-:.]/g, "").replace("Z", "Z")}`;
}

function relativeOrAbsolute(root, value) {
  const relative = path.relative(root, value);
  return relative && !relative.startsWith("..") ? relative : value;
}

async function runAdapter(sourceId, context) {
  if (sourceId === "arxiv") {
    return discoverArxiv({
      researchConfig: context.researchConfig,
      topicIds: context.topicIds,
      window: context.window,
      now: context.now,
      fixtureFile: context.fixtureArxiv,
      fetchImpl: context.fetchImpl,
      requestDelayMs: context.requestDelayMs,
      pageSize: context.pageSize,
      maxResultsPerTopic: context.maxResultsPerTopic,
      sleepImpl: context.sleepImpl,
      clockImpl: context.clockImpl,
    });
  }
  if (sourceId === "openreview") return discoverOpenReview(context);
  if (sourceId === "venue-proceedings") return discoverVenueProceedings(context);
  if (sourceId === "official-reports") return discoverOfficialReports(context);
  throw new Error(`Unsupported source: ${sourceId}`);
}

function sourceFailureStatus(sourceId, error) {
  return {
    id: sourceId,
    implementation: "adapter",
    mode: "failed-before-fetch-completed",
    status: "failed",
    live: sourceId === "arxiv",
    requestCount: 0,
    fetchedEntryCount: 0,
    inWindowEntryCount: 0,
    queries: [],
    error: error instanceof Error ? error.message : String(error),
  };
}

function stateEligibility({ recordSuccess, fixtureArxiv, sourceStatuses, writeOutputs }) {
  if (!recordSuccess) {
    return { requested: false, eligible: false, updated: false, reasons: [] };
  }

  const reasons = [];
  if (!writeOutputs) reasons.push("A no-write run cannot advance the live watermark.");
  const liveStatuses = sourceStatuses.filter((source) => source.live);
  if (fixtureArxiv) reasons.push("Fixture runs cannot advance the live watermark.");
  if (!liveStatuses.some((source) => source.requestCount > 0 && source.status === "checked")) {
    reasons.push("No live source completed at least one successful request.");
  }
  for (const source of liveStatuses) {
    if (source.status !== "checked") {
      reasons.push(`Live source '${source.id}' ended with status '${source.status}'.`);
    }
  }

  return {
    requested: true,
    eligible: reasons.length === 0,
    updated: false,
    reasons,
  };
}

export async function runDiscovery(inputOptions = {}) {
  const root = path.resolve(inputOptions.root ?? process.cwd());
  const contentRoot = path.resolve(
    root,
    inputOptions.contentRoot ?? path.join("content", "paper-reading"),
  );
  const stateFile = path.resolve(
    root,
    inputOptions.stateFile ?? path.join(contentRoot, "state", "discovery-state.json"),
  );
  const now = new Date(inputOptions.now ?? new Date().toISOString()).toISOString();
  const state = (await readJsonIfPresent(stateFile, null)) ?? defaultState();
  if (state.schemaVersion !== 1) throw new Error("Discovery state schemaVersion must be 1.");
  const window = computeDiscoveryWindow({
    state,
    since: inputOptions.since,
    now,
    overlapHours: inputOptions.overlapHours,
  });
  const runId = inputOptions.runId ?? runIdFor(now);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw new Error("runId may contain only letters, numbers, dots, underscores, and hyphens.");
  }
  const outputRoot = path.resolve(
    root,
    inputOptions.outputRoot ?? path.join("local-assets", "paper-reading", "runs"),
  );
  const runDirectory = path.join(outputRoot, runId);
  const candidatesFile = path.join(runDirectory, "candidates.json");
  const manifestFile = path.join(runDirectory, "manifest.json");
  if (
    inputOptions.writeOutputs !== false &&
    (existsSync(candidatesFile) || existsSync(manifestFile))
  ) {
    throw new Error(
      `Run '${runId}' already has discovery artifacts. Resume that run or choose a new run ID; discovery will not overwrite it.`,
    );
  }

  const [researchConfig, venueRegistry, canonicalPapers] = await Promise.all([
    readJson(path.join(contentRoot, "research-config.json")),
    readJson(path.join(contentRoot, "venue-registry.json")),
    readJsonDirectory(path.join(contentRoot, "papers")),
  ]);
  const configuredTopicIds = new Set(
    researchConfig.directions.map((direction) => direction.id),
  );
  for (const topicId of inputOptions.topicIds ?? []) {
    if (!configuredTopicIds.has(topicId)) {
      throw new Error(`Unknown research direction '${topicId}'.`);
    }
  }

  const sources = inputOptions.sources ?? SOURCE_IDS;
  const sourceStatuses = [];
  const sourceRecords = [];
  const adapterContext = {
    researchConfig,
    venueRegistry,
    topicIds: inputOptions.topicIds,
    window,
    now,
    fixtureArxiv: inputOptions.fixtureArxiv
      ? path.resolve(root, inputOptions.fixtureArxiv)
      : null,
    fetchImpl: inputOptions.fetchImpl,
    requestDelayMs: inputOptions.requestDelayMs,
    pageSize: inputOptions.pageSize,
    maxResultsPerTopic: inputOptions.maxResultsPerTopic,
    sleepImpl: inputOptions.sleepImpl,
    clockImpl: inputOptions.clockImpl,
  };

  for (const sourceId of sources) {
    try {
      const result = await runAdapter(sourceId, adapterContext);
      sourceRecords.push(...result.records);
      sourceStatuses.push(result.status);
    } catch (error) {
      sourceStatuses.push(sourceFailureStatus(sourceId, error));
    }
  }

  const merged = mergeSourceDuplicates(sourceRecords, venueRegistry);
  const candidates = matchCanonicalCandidates(
    merged,
    buildCanonicalIndex(canonicalPapers),
  );
  const dispositionCounts = candidates.reduce((counts, candidate) => {
    counts[candidate.disposition] = (counts[candidate.disposition] ?? 0) + 1;
    return counts;
  }, {});
  const stateUpdate = stateEligibility({
    recordSuccess: inputOptions.recordSuccess,
    fixtureArxiv: adapterContext.fixtureArxiv,
    sourceStatuses,
    writeOutputs: inputOptions.writeOutputs !== false,
  });

  const candidatePayload = {
    schemaVersion: 1,
    runId,
    generatedAt: now,
    mode: "dry-run-staging",
    window,
    editorialStatus: "unreviewed",
    notice:
      "These are normalized retrieval candidates, not accepted papers. No model screening or summary has run.",
    candidates,
  };
  const manifest = {
    schemaVersion: 1,
    runId,
    generatedAt: now,
    mode: "dry-run-staging",
    guarantees: {
      canonicalPapersWritten: false,
      digestsWritten: false,
      sitePublished: false,
      modelScreeningRun: false,
      modelSummariesGenerated: false,
    },
    window,
    state: {
      file: relativeOrAbsolute(root, stateFile),
      before: {
        lastSuccessfulRunAt: state.lastSuccessfulRunAt ?? null,
        lastRunId: state.lastRunId ?? null,
      },
      update: stateUpdate,
    },
    configuration: {
      researchConfig: relativeOrAbsolute(
        root,
        path.join(contentRoot, "research-config.json"),
      ),
      researchConfigStatus: researchConfig.status,
      venueRegistry: relativeOrAbsolute(
        root,
        path.join(contentRoot, "venue-registry.json"),
      ),
      venueRegistryStatus: venueRegistry.status,
      selectedTopicIds:
        inputOptions.topicIds ?? researchConfig.directions.map((direction) => direction.id),
      selectedSourceIds: sources,
    },
    sourceStatus: sourceStatuses,
    counts: {
      sourceRecords: sourceRecords.length,
      mergedCandidates: candidates.length,
      new: dispositionCounts.new ?? 0,
      possibleUpdates: dispositionCounts["possible-update"] ?? 0,
      duplicateExisting: dispositionCounts["duplicate-existing"] ?? 0,
      manualReview: dispositionCounts["manual-review"] ?? 0,
      failedSources: sourceStatuses.filter((source) => source.status === "failed").length,
      partialSources: sourceStatuses.filter((source) => source.status === "partial").length,
      notConfiguredSources: sourceStatuses.filter(
        (source) => source.status === "not-configured",
      ).length,
    },
    outputs: {
      candidates: relativeOrAbsolute(root, candidatesFile),
      manifest: relativeOrAbsolute(root, manifestFile),
    },
    limitations: [
      "Only the arXiv Atom API adapter is implemented; other registered sources report not-configured.",
      "Retrieval-topic matches show which query surfaced a record; they are not final relevance labels.",
      "The arXiv safety cap can make a topic partial; a partial live run cannot advance state.",
      "No PDF/full-text acquisition, semantic ranking, editorial analysis, or digest generation runs here.",
    ],
  };

  if (inputOptions.writeOutputs !== false) {
    await Promise.all([
      writeJsonAtomic(candidatesFile, candidatePayload),
      writeJsonAtomic(manifestFile, manifest),
    ]);
  }

  if (inputOptions.recordSuccess && stateUpdate.eligible) {
    const nextState = {
      ...state,
      schemaVersion: 1,
      lastSuccessfulRunAt: window.end,
      lastRunId: runId,
      lastManifestPath: relativeOrAbsolute(root, manifestFile),
      overlapHours: window.overlapHours,
      updatedAt: now,
    };
    await writeJsonAtomic(stateFile, nextState);
    stateUpdate.updated = true;
    stateUpdate.after = {
      lastSuccessfulRunAt: nextState.lastSuccessfulRunAt,
      lastRunId: nextState.lastRunId,
    };
    await writeJsonAtomic(manifestFile, manifest);
  }

  return {
    candidatePayload,
    manifest,
    candidatesFile,
    manifestFile,
    hasSourceFailures: sourceStatuses.some((source) =>
      ["failed", "partial"].includes(source.status),
    ),
    stateUpdateBlocked: Boolean(inputOptions.recordSuccess && !stateUpdate.eligible),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
    return;
  }

  const result = await runDiscovery(options);
  console.log(
    `[paper-reading] staged ${result.manifest.counts.mergedCandidates} candidates (${result.manifest.counts.new} new, ${result.manifest.counts.possibleUpdates} possible updates)`,
  );
  if (options.writeOutputs !== false) {
    console.log(`[paper-reading] manifest: ${result.manifestFile}`);
    console.log(`[paper-reading] candidates: ${result.candidatesFile}`);
  }
  if (result.stateUpdateBlocked) {
    console.error(
      `[paper-reading] state not advanced: ${result.manifest.state.update.reasons.join(" ")}`,
    );
    process.exitCode = 2;
  } else if (result.hasSourceFailures) {
    process.exitCode = 2;
  }
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[paper-reading] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
