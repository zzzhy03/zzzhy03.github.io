import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { parseArxivIdentifier } from "./identity.mjs";

export function paperVersion(paper) {
  const link = paper.links?.find((item) => item.label === "Paper");
  return parseArxivIdentifier(link?.href)?.version ?? null;
}

export function isPaperWithdrawn(paper) {
  if (!paper.withdrawal) return false;
  const withdrawn = parseArxivIdentifier(paper.withdrawal.arxivVersion);
  const version = paperVersion(paper);
  // An unversioned link cannot demonstrate that a later version was reviewed.
  return !withdrawn?.version || !version || version <= withdrawn.version;
}

export function publicDigest(digest, visiblePaperIds, withdrawnVersions = new Map(), reviewedVersions = new Map()) {
  const visible = (id) => {
    if (!visiblePaperIds.has(id)) return false;
    if (!withdrawnVersions.has(id)) return true;
    const reviewed = parseArxivIdentifier(reviewedVersions.get(id));
    // A later reacceptance must not resurrect v1 in its historical digest.
    return reviewed?.version > withdrawnVersions.get(id) && `arxiv:${reviewed.id}` === id;
  };
  const removed = digest.paperIds.filter((id) => !visible(id));
  if (!removed.length) return digest;
  return {
    ...digest,
    paperIds: digest.paperIds.filter(visible),
    overview: {
      ...digest.overview,
      bulletsZh: [
        ...digest.overview.bulletsZh,
        `已从公开收录中移除 ${removed.length} 篇撤稿论文；原始收录与审计记录仍保留。`,
      ],
    },
    topicBriefs: digest.topicBriefs.map((brief) => ({
      ...brief,
      paperIds: brief.paperIds.filter(visible),
    })),
  };
}

export function validateWithdrawalSource(review, root, reviewFile) {
  const errors = [];
  const source = review.source;
  const label = path.basename(reviewFile);
  if (source?.scope !== "withdrawal_notice") return [`${label} requires a withdrawal notice.`];
  if (typeof review.arxivVersion !== "string" || !/^\d{4}\.\d{4,5}v[1-9]\d*$/.test(review.arxivVersion)) {
    return [`${label} withdrawal notice requires an exact versioned arXiv ID.`];
  }
  if (review.decision !== "reject" || review.readingAction !== "skip") {
    errors.push(`${label} withdrawal notices may only reject the version event with readingAction=skip.`);
  }
  const exactUrl = `https://arxiv.org/abs/${review.arxivVersion}`;
  if (source.noticeUrl !== exactUrl) errors.push(`${label} noticeUrl must be '${exactUrl}'.`);
  if (typeof source.retrievedAt !== "string" || Number.isNaN(Date.parse(source.retrievedAt))) {
    errors.push(`${label} notice retrievedAt must be an ISO timestamp.`);
  }
  if (!/^[a-f0-9]{64}$/.test(source.noticeSha256 ?? "")) {
    errors.push(`${label} noticeSha256 must be a SHA-256.`);
  }
  if (["pdfPath", "pdfSha256", "pageCount", "textExtraction", "visuallyInspectedPages"]
    .some((field) => source[field] !== undefined)) {
    errors.push(`${label} withdrawal notices must not claim PDF evidence.`);
  }
  if (typeof source.noticePath !== "string" || path.isAbsolute(source.noticePath)) {
    return [...errors, `${label} noticePath must be a repository-relative path.`];
  }
  const noticePath = path.resolve(root, source.noticePath);
  const sourcesDirectory = path.resolve(path.dirname(reviewFile), "..", "sources");
  try {
    if (lstatSync(noticePath).isSymbolicLink() ||
        path.dirname(realpathSync(noticePath)) !== realpathSync(sourcesDirectory)) {
      return [...errors, `${label} notice must remain inside this run's fulltext/sources.`];
    }
    const bytes = readFileSync(noticePath);
    if (createHash("sha256").update(bytes).digest("hex") !== source.noticeSha256) {
      errors.push(`${label} withdrawal notice SHA-256 does not match.`);
    }
    const html = bytes.toString("utf8");
    const escapedVersion = review.arxivVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`<title>\\s*\\[${escapedVersion}\\]`, "i").test(html)) {
      errors.push(`${label} notice does not identify the exact reviewed version.`);
    }
    // v1's 'A newer version ... withdrawn' banner is NOT evidence that v1 was withdrawn.
    if (!/<span\b[^>]*class=["'][^"']*\berror\b[^"']*["'][^>]*>\s*This paper has been withdrawn by\b/i.test(html)) {
      errors.push(`${label} notice does not explicitly withdraw this version.`);
    }
  } catch (error) {
    errors.push(`${label} cannot verify the archived withdrawal notice: ${error.message}`);
  }
  return errors;
}

export function withdrawalRecord(review) {
  return {
    arxivVersion: review.arxivVersion,
    runId: review.runId,
    recordedAt: review.reviewedAt,
    reasonZh: review.decisionRationaleZh,
    noticeUrl: review.source.noticeUrl,
    noticeSha256: review.source.noticeSha256,
  };
}
