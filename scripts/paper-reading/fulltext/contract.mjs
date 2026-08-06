export const FULLTEXT_SCHEMA_VERSION = 2;

export const FULLTEXT_DECISIONS = [
  "accept-deep",
  "accept-skim",
  "defer",
  "reject",
];

export const RELEVANCE_LEVELS = ["high", "medium", "low"];
export const READING_ACTIONS = ["deep", "skim", "skip"];
export const CONFIDENCE_LEVELS = ["high", "medium", "low"];
export const EVIDENCE_SUPPORT = [
  "paper-method",
  "paper-experiment",
  "reviewer-inference",
];
export const CODE_STATUSES = ["available", "promised", "not-found"];

export const ACCEPT_DECISIONS = new Set(["accept-deep", "accept-skim"]);
