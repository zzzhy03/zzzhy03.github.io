// Applied to new screening snapshots only; historical reviews retain their recorded policy.
export function admissionErrors(decision, gate) {
  if (!gate || !["full-text-review", "accept-from-abstract"].includes(decision.decision)) return [];
  if (["major", "landmark"].includes(decision.significance)) return [];
  const evidence = decision.transferEvidence;
  if (!evidence || !gate.transferTopicIds.includes(evidence.targetTopicId) ||
      ![evidence.mechanismZh, evidence.benefitZh, evidence.evidenceLocator].every((text) => typeof text === "string" && text.trim())) {
    return ["requires major/landmark significance or explicit transferEvidence (targetTopicId, mechanismZh, benefitZh, evidenceLocator) for a main research topic; generic relevance is insufficient"];
  }
  return [];
}
