import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runDiscovery } from "../discover.mjs";
import { parseArxivAtomFeed } from "../lib/atom.mjs";
import {
  buildCanonicalIndex,
  matchCanonicalCandidates,
  mergeSourceDuplicates,
} from "../lib/dedupe.mjs";
import {
  buildIdentityKeys,
  normalizeArxivId,
  normalizeDoi,
  normalizeOpenReviewForumId,
  normalizeTitle,
} from "../lib/identity.mjs";
import { compileArxivQueries } from "../lib/query-compiler.mjs";
import { computeDiscoveryWindow } from "../lib/window.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../..");
const fixtureFile = path.join(testDirectory, "../fixtures/arxiv-window.atom.xml");

test("watermark windows subtract overlap while bootstrap --since is exact", () => {
  const incremental = computeDiscoveryWindow({
    state: { lastSuccessfulRunAt: "2026-08-06T00:00:00Z", overlapHours: 48 },
    now: "2026-08-07T00:00:00Z",
  });
  assert.equal(incremental.start, "2026-08-04T00:00:00.000Z");
  assert.equal(incremental.end, "2026-08-07T00:00:00.000Z");
  assert.equal(incremental.basis, "last-successful-run-with-overlap");

  const bootstrap = computeDiscoveryWindow({
    state: { lastSuccessfulRunAt: null, overlapHours: 48 },
    since: "2026-08-06T08:00:00+08:00",
    now: "2026-08-07T00:00:00Z",
  });
  assert.equal(bootstrap.start, "2026-08-06T00:00:00.000Z");
  assert.equal(bootstrap.basis, "explicit-since");
});

test("identifier normalization handles DOI, versionless arXiv, and OpenReview forums", () => {
  assert.equal(normalizeDoi("https://doi.org/10.1000/ABC.Def."), "10.1000/abc.def");
  assert.equal(normalizeArxivId("https://arxiv.org/pdf/2608.01234v7.pdf"), "2608.01234");
  assert.equal(
    normalizeOpenReviewForumId("https://openreview.net/forum?id=AbCd_1234"),
    "AbCd_1234",
  );
  assert.equal(normalizeTitle("  A—Structured: Paper!  "), "a structured paper");
});

test("canonical OpenReview openReviewForum fields participate in exact dedupe", () => {
  const canonical = {
    id: "openreview:AbCd_1234",
    title: "A Known Forum Paper",
    authors: ["One Author"],
    publishedAt: "2026-01-01",
    identifiers: { openReviewForum: "AbCd_1234" },
    links: [],
  };
  const candidate = {
    title: "Renamed Forum Submission",
    authors: ["One Author"],
    year: 2026,
    publishedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-08-05T00:00:00Z",
    abstract: "",
    categories: [],
    identifiers: { doi: [], arxiv: [], openreview: ["AbCd_1234"] },
    links: [],
    retrievalTopicIds: ["vlm-mllm"],
    windowMatch: {
      inWindow: true,
      publishedInWindow: false,
      updatedInWindow: true,
      changeKind: "updated",
    },
    sourceRecords: [
      {
        source: "openreview",
        sourceRecordId: "AbCd_1234",
        url: "https://openreview.net/forum?id=AbCd_1234",
      },
    ],
  };
  const venueRegistry = { aliasMatching: {}, venues: [] };
  const [merged] = mergeSourceDuplicates([candidate], venueRegistry);
  const [matched] = matchCanonicalCandidates(
    [merged],
    buildCanonicalIndex([canonical]),
  );
  assert.equal(matched.existingMatch.paperId, canonical.id);
  assert.equal(matched.existingMatch.matchType, "openreview");
});

test("Atom fixture preserves old-paper updates and drops records outside both dates", async () => {
  const parsed = parseArxivAtomFeed(await readFile(fixtureFile, "utf8"));
  assert.equal(parsed.entries.length, 4);
  assert.equal(parsed.entries[0].authors.length, 2);

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "paper-reading-update-match-"));
  const contentRoot = path.join(temporaryRoot, "content");
  const paperDirectory = path.join(contentRoot, "papers");
  await mkdir(paperDirectory, { recursive: true });
  await Promise.all([
    copyFile(
      path.join(repositoryRoot, "content/paper-reading/research-config.json"),
      path.join(contentRoot, "research-config.json"),
    ),
    copyFile(
      path.join(repositoryRoot, "content/paper-reading/venue-registry.json"),
      path.join(contentRoot, "venue-registry.json"),
    ),
    writeFile(
      path.join(paperDirectory, "refinesvg.json"),
      `${JSON.stringify({
        id: "arxiv:2607.27699",
        slug: "refinesvg",
        title: "RefineSVG: A Visual-Feedback-Aware Framework for Text-to-Vector-Graphics Generation",
        authors: ["Fixture Author"],
        publishedAt: "2026-07-01",
        identifiers: { arxiv: "2607.27699" },
        links: [{ label: "Paper", href: "https://arxiv.org/abs/2607.27699v1" }],
      })}\n`,
    ),
  ]);

  const result = await runDiscovery({
    root: repositoryRoot,
    contentRoot,
    since: "2026-08-04T00:00:00Z",
    now: "2026-08-06T00:00:00Z",
    sources: ["arxiv"],
    topicIds: ["lego", "embroidery", "2d-design"],
    fixtureArxiv: fixtureFile,
    runId: "fixture-window",
    writeOutputs: false,
  });

  assert.equal(result.manifest.sourceStatus[0].status, "checked");
  assert.equal(result.manifest.sourceStatus[0].rateLimit.minimumDelayMs, 3_100);
  assert.equal(result.candidatePayload.candidates.length, 3);
  assert.equal(
    result.candidatePayload.candidates.some(
      (candidate) => candidate.identifiers.arxiv[0] === "2401.00001",
    ),
    false,
  );
  const lego = result.candidatePayload.candidates.find(
    (candidate) => candidate.identifiers.arxiv[0] === "2501.01234",
  );
  assert.equal(lego.windowMatch.changeKind, "updated");
  assert.deepEqual(lego.locallyMatchedTopicIds, ["lego"]);
  const refineSvg = result.candidatePayload.candidates.find(
    (candidate) => candidate.identifiers.arxiv[0] === "2607.27699",
  );
  assert.equal(refineSvg.disposition, "possible-update");
  assert.equal(
    refineSvg.existingMatch.detectedChanges.some(
      (change) => change.field === "paper-version",
    ),
    true,
  );
});

test("query compiler emits one merged arXiv query per direction", async () => {
  const config = JSON.parse(
    await readFile(path.join(repositoryRoot, "content/paper-reading/research-config.json"), "utf8"),
  );
  const queries = compileArxivQueries(config, ["2d-design"]);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].familyCount, 3);
  assert.match(queries[0].query, / OR /);
});

test("provider-only hits remain staged without becoming locally matched topics", async () => {
  const providerOnlyFeed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <opensearch:itemsPerPage>1</opensearch:itemsPerPage>
  <entry>
    <id>https://arxiv.org/abs/2608.19999v1</id>
    <updated>2026-08-05T12:00:00Z</updated>
    <published>2026-08-05T12:00:00Z</published>
    <title>A Provider-Stemmed Result Without Configured Topic Terms</title>
    <summary>This abstract is intentionally unrelated to the selected research direction.</summary>
    <author><name>Query Example</name></author>
    <category term="cs.AI"/>
    <link href="https://arxiv.org/abs/2608.19999v1" rel="alternate" type="text/html"/>
  </entry>
</feed>`;
  const result = await runDiscovery({
    root: repositoryRoot,
    since: "2026-08-04T00:00:00Z",
    now: "2026-08-06T00:00:00Z",
    sources: ["arxiv"],
    topicIds: ["lego"],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => providerOnlyFeed,
    }),
    runId: "provider-only-match",
    writeOutputs: false,
  });

  assert.equal(result.candidatePayload.candidates.length, 1);
  assert.deepEqual(result.candidatePayload.candidates[0].retrievalTopicIds, ["lego"]);
  assert.deepEqual(result.candidatePayload.candidates[0].locallyMatchedTopicIds, []);
  assert.equal(
    result.manifest.sourceStatus[0].queries[0].providerOnlyInWindowEntryCount,
    1,
  );
});

test("fixture runs cannot advance the successful live watermark", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "paper-reading-discovery-"));
  const stateFile = path.join(temporaryRoot, "state.json");
  await writeFile(
    stateFile,
    `${JSON.stringify({
      schemaVersion: 1,
      lastSuccessfulRunAt: null,
      lastRunId: null,
      overlapHours: 48,
    })}\n`,
  );

  const result = await runDiscovery({
    root: repositoryRoot,
    since: "2026-08-04T00:00:00Z",
    now: "2026-08-06T00:00:00Z",
    sources: ["arxiv"],
    topicIds: ["lego"],
    fixtureArxiv: fixtureFile,
    stateFile,
    outputRoot: path.join(temporaryRoot, "staging"),
    runId: "fixture-no-watermark",
    recordSuccess: true,
    writeOutputs: true,
  });
  const stateAfter = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(result.stateUpdateBlocked, true);
  assert.equal(stateAfter.lastSuccessfulRunAt, null);
});

test("discovery never overwrites an existing run", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "paper-reading-no-overwrite-"));
  const options = {
    root: repositoryRoot,
    since: "2026-08-04T00:00:00Z",
    now: "2026-08-06T00:00:00Z",
    sources: ["arxiv"],
    topicIds: ["lego"],
    fixtureArxiv: fixtureFile,
    outputRoot: path.join(temporaryRoot, "runs"),
    runId: "immutable-run",
    writeOutputs: true,
  };
  await runDiscovery(options);
  await assert.rejects(
    () => runDiscovery(options),
    /already has discovery artifacts.*will not overwrite/s,
  );
});

test("a complete mocked live fetch can explicitly advance the watermark", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "paper-reading-live-success-"));
  const stateFile = path.join(temporaryRoot, "state.json");
  await writeFile(
    stateFile,
    `${JSON.stringify({
      schemaVersion: 1,
      lastSuccessfulRunAt: null,
      lastRunId: null,
      overlapHours: 48,
    })}\n`,
  );
  const fixtureXml = await readFile(fixtureFile, "utf8");
  let requestCount = 0;
  const fetchImpl = async () => {
    requestCount += 1;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => fixtureXml,
    };
  };

  const result = await runDiscovery({
    root: repositoryRoot,
    since: "2026-08-04T00:00:00Z",
    now: "2026-08-06T00:00:00Z",
    sources: ["arxiv"],
    topicIds: ["lego"],
    fetchImpl,
    stateFile,
    outputRoot: path.join(temporaryRoot, "staging"),
    runId: "mock-live-success",
    recordSuccess: true,
    writeOutputs: true,
  });
  const stateAfter = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(requestCount, 1);
  assert.equal(result.stateUpdateBlocked, false);
  assert.equal(result.manifest.state.update.updated, true);
  assert.equal(stateAfter.lastSuccessfulRunAt, "2026-08-06T00:00:00.000Z");
  assert.equal(stateAfter.lastRunId, "mock-live-success");
});

test("identity keys honor DOI before arXiv before title-author-year", () => {
  const keys = buildIdentityKeys({
    title: "Identity Ordering",
    authors: ["First Author"],
    year: 2026,
    identifiers: {
      doi: "10.1000/order",
      arxiv: "2608.12345v2",
      openReviewForum: "Forum_123",
    },
  });
  assert.deepEqual(
    keys.map((key) => key.type),
    ["doi", "arxiv", "openreview", "title-author-year"],
  );
});
