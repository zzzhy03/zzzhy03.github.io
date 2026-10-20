export type ModelUpdate = {
  schemaVersion: 1;
  id: string;
  publisherId: string;
  title: string;
  model: string;
  eventType: "model-release" | "technical-report" | "capability-update" | "weights-release";
  publishedAt: string;
  reviewedAt: string;
  sourceUrl: string;
  summaryZh: string;
  changesZh: string[];
  availabilityZh: string;
  evidenceNoteZh: string;
  links: { label: string; href: string }[];
};

export type ModelUpdatesDataset = {
  publishers: { id: string; name: string; homeUrl: string }[];
  events: ModelUpdate[];
  checks: {
    schemaVersion: 1;
    checkedAt: string | null;
    sources: { publisherId: string; status: "checked" | "partial" | "failed"; checkedAt: string; noteZh?: string }[];
  };
};
