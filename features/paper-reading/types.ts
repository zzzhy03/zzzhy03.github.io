export type Relevance = "high" | "medium" | "low";

export type ReadingAction = "deep" | "skim" | "skip";

export type EvidenceMaturity = "solid" | "mixed" | "early";

export type SourceScope = "full_text" | "abstract" | "metadata";

export type PublicationType = "peer-reviewed" | "preprint" | "technical-report";

export type PaperIdentifiers = {
  doi?: string;
  arxiv?: string;
  openReviewForum?: string;
};

export type PaperFacets = Record<string, string[]>;

export type PaperTopic = {
  id: string;
  labelZh: string;
  labelEn: string;
  shortLabel: string;
  descriptionZh: string;
  accent: "teal" | "blue" | "amber" | "violet" | "rose";
};

export type PaperLink = {
  label: "Paper" | "Project" | "Code" | "DOI";
  href: string;
};

export type PaperVisual = {
  src: string;
  alt: string;
  caption: string;
  generated: boolean;
};

export type PaperRecord = {
  id: string;
  slug: string;
  title: string;
  authors: string[];
  publishedAt: string;
  updatedAt?: string;
  collectedAt: string;
  venue: string;
  identifiers?: PaperIdentifiers;
  venueIds?: string[];
  publicationType?: PublicationType;
  categories: string[];
  topicIds: string[];
  primaryTopicId?: string;
  keywords: string[];
  facets?: PaperFacets;
  abstract: string;
  abstractIsOriginal: boolean;
  abstractSourceUrl: string;
  links: PaperLink[];
  visual?: PaperVisual;
  analysis: {
    sourceScope: SourceScope;
    sourceNote: string;
    ideaZh: string;
    methodFlow: string[];
    whyRelevantZh?: string;
    evidenceZh?: string;
    caveatZh?: string;
    motivationZh: string;
    methodZh: string;
    experimentsZh: string;
    insightZh: string;
    relevance: Relevance;
    readingAction: ReadingAction;
    evidenceMaturity: EvidenceMaturity;
  };
};

export type PaperLibraryEntry = Pick<
  PaperRecord,
  | "id"
  | "slug"
  | "title"
  | "authors"
  | "publishedAt"
  | "updatedAt"
  | "venue"
  | "categories"
  | "topicIds"
  | "keywords"
> & {
  identifiers: PaperIdentifiers;
  venueIds: string[];
  publicationType: PublicationType;
  primaryTopicId: string;
  facets: PaperFacets;
  collectedAt: string;
  firstReportedDate: string | null;
  lastReportedDate: string | null;
  digestDates: string[];
  paperHref: string;
  codeHref?: string;
  hasCode: boolean;
  ideaZh: string;
  sourceScope: SourceScope;
  relevance: Relevance;
  readingAction: ReadingAction;
  evidenceMaturity: EvidenceMaturity;
};

export type PaperLibraryMetaOption = {
  id: string;
  label: string;
  labelZh?: string;
};

export type PaperLibraryMeta = {
  schemaVersion: 1;
  generatedAt: string;
  topics: Pick<
    PaperTopic,
    "id" | "labelZh" | "labelEn" | "shortLabel" | "accent"
  >[];
  venues: PaperLibraryMetaOption[];
  facetDimensions: {
    id: string;
    labelZh: string;
    values: PaperLibraryMetaOption[];
  }[];
  publicationTypes: PaperLibraryMetaOption[];
  relevanceOptions: PaperLibraryMetaOption[];
  readingActionOptions: PaperLibraryMetaOption[];
  sourceScopeOptions: PaperLibraryMetaOption[];
  evidenceMaturityOptions: PaperLibraryMetaOption[];
};

export type TopicBrief = {
  topicId: string;
  headlineZh: string;
  summaryZh: string;
  paperIds: string[];
};

export type DailyDigest = {
  date: string;
  generatedAt: string;
  mode: "preview" | "daily" | "backfill";
  paperIds: string[];
  overview: {
    headlineZh: string;
    bulletsZh: string[];
  };
  topicBriefs: TopicBrief[];
  sourceStatus: {
    label: string;
    status: "checked" | "partial" | "failed";
    noteZh: string;
  }[];
};

export type DigestIndexEntry = Pick<DailyDigest, "date" | "generatedAt" | "mode">;

export type PaperReadingDigestBundle = {
  digest: DailyDigest;
  papers: PaperRecord[];
};

export type PaperReadingDataset = {
  topics: PaperTopic[];
  digestIndex: DigestIndexEntry[];
  initial: PaperReadingDigestBundle;
};

export type PaperUserState = {
  relevance?: Relevance;
  readingAction?: ReadingAction;
  starred?: boolean;
  starredAt?: string;
  readLater?: boolean;
  readLaterAt?: string;
  read?: boolean;
  archiveRequested?: boolean;
};
