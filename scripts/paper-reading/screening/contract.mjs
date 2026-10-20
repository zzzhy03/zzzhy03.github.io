export const SCREENING_SCHEMA_VERSION = 1;

export const DECISIONS = [
  "reject",
  "full-text-review",
  "accept-from-abstract",
  "manual-review",
];

export const TOPIC_MATCHES = ["direct", "transferable", "broad", "none"];

export const SIGNIFICANCE_LEVELS = [
  "incremental",
  "meaningful",
  "major",
  "landmark",
  "unknown",
];

export const NEGATIVE_SIGNAL_STATUSES = [
  "none",
  "context-only",
  "applies",
  "uncertain",
];

export const SOURCE_SCOPES = ["metadata", "abstract", "full_text"];
export const RELEVANCE_LEVELS = ["high", "medium", "low"];
export const READING_ACTIONS = ["deep", "skim", "skip"];
export const ATTENTION_GATE_OUTCOMES = ["pass", "fail", "uncertain"];
export const SCREENING_BASES = ["metadata", "abstract"];
export const DOWNSTREAM_CLAIM_SCOPES = [
  "metadata-only",
  "abstract-only",
  "full-text-required",
  "manual-verification-required",
];

export const REASON_CODES = [
  "direct-topic-fit",
  "transferable-to-tracked-topic",
  "broad-domain-only",
  "no-topic-fit",
  "attention-gate-pass",
  "attention-gate-fail",
  "attention-gate-uncertain",
  "incremental-contribution",
  "meaningful-advance",
  "major-advance",
  "landmark-advance",
  "significance-unclear",
  "abstract-sufficient",
  "needs-full-text",
  "manual-review-needed",
  "negative-signal-applies",
  "negative-signal-context-only",
  "negative-signal-uncertain",
  "cross-routed",
  "venue-signal",
  "venue-not-decisive",
  "already-canonical",
  "possible-canonical-update",
  "identity-conflict",
  "out-of-scope",
  "non-technical",
  "excluded-subfield",
  "source-quality-uncertain",
  "other-reviewed-reason",
];

export const TOPIC_REASON_BY_MATCH = {
  direct: "direct-topic-fit",
  transferable: "transferable-to-tracked-topic",
  broad: "broad-domain-only",
  none: "no-topic-fit",
};

export const SIGNIFICANCE_REASON_BY_LEVEL = {
  incremental: "incremental-contribution",
  meaningful: "meaningful-advance",
  major: "major-advance",
  landmark: "landmark-advance",
  unknown: "significance-unclear",
};

export const GATE_REASON_BY_OUTCOME = {
  pass: "attention-gate-pass",
  fail: "attention-gate-fail",
  uncertain: "attention-gate-uncertain",
};

export const NEGATIVE_REASON_BY_STATUS = {
  "context-only": "negative-signal-context-only",
  applies: "negative-signal-applies",
  uncertain: "negative-signal-uncertain",
};

export function buildReviewContract() {
  return {
    schemaVersion: SCREENING_SCHEMA_VERSION,
    outputKind: "paper-reading-screening-review",
    requiredTopLevelFields: [
      "schemaVersion",
      "kind",
      "runId",
      "batchId",
      "reviewer",
      "reviewedAt",
      "decisions",
    ],
    reviewer: {
      kind: ["ai", "human"],
      requiredFields: ["kind", "name"],
      aiAlsoRequires: ["model"],
    },
    decision: {
      requiredFields: [
        "candidateId",
        "decision",
        "primaryTopicId",
        "secondaryTopicIds",
        "topicMatch",
        "significance",
        "reasonCodes",
        "rationaleZh",
        "negativeSignalAssessment",
        "attentionGate",
        "suggestedSourceScope",
        "preliminary",
        "facetHints",
        "evidenceBoundary",
      ],
      decision: DECISIONS,
      topicMatch: TOPIC_MATCHES,
      significance: SIGNIFICANCE_LEVELS,
      reasonCodes: REASON_CODES,
      negativeSignalAssessment: {
        requiredFields: ["status", "matchedSignals", "rationaleZh"],
        status: NEGATIVE_SIGNAL_STATUSES,
      },
      attentionGate: {
        requiredFields: ["policyId", "outcome", "rationaleZh"],
        outcome: ATTENTION_GATE_OUTCOMES,
      },
      suggestedSourceScope: SOURCE_SCOPES,
      preliminary: {
        requiredFields: ["relevance", "readingAction"],
        relevance: RELEVANCE_LEVELS,
        readingAction: READING_ACTIONS,
      },
      evidenceBoundary: {
        requiredFields: [
          "screeningBasis",
          "basisSufficientForDecision",
          "downstreamClaimScope",
        ],
        screeningBasis: SCREENING_BASES,
        downstreamClaimScope: DOWNSTREAM_CLAIM_SCOPES,
      },
      textLimitsUnicodeCodePoints: {
        rationaleZh: 300,
        negativeSignalRationaleZh: 240,
        attentionGateRationaleZh: 240,
      },
    },
    invariantsZh: [
      "retrievalTopicIds 只表示哪条检索 query 找到了论文，不是最终分类或相关性判断。primaryTopicId 与 secondaryTopicIds 必须根据论文实际贡献重新判断。",
      "必须按最终 primary topic 的 attentionPolicy gate 判断是否达到收录门槛；venue 只是该 gate 中的信号，不会自动触发收录。",
      "允许 cross-routing：最终 primary topic 不必出现在 retrievalTopicIds 中；发生 cross-routing 时加入 cross-routed reason code。",
      "每个 candidate 在完整 review set 中必须恰好出现一次；一个 batch 对应一个 review 文件。",
      "facetHints 是初步受控标签提示，不是 canonical facets；此阶段不会写入正式论文记录。",
      "accept-from-abstract 只允许用于 abstract 已足以可靠判断的候选；suggestedSourceScope 必须是 abstract，且 evidenceBoundary 必须把后续表述限制为 abstract-only，禁止声称已验证全文证据。",
      "full-text-review 表示 abstract 不足以完成可靠判断，下一阶段必须获取并检查全文；它不是正式收录。",
      "manual-review 表示身份、来源、归类或判断仍需人工核验；它不是正式收录。",
    ],
  };
}
