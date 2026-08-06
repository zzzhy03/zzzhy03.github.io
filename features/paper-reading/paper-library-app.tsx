"use client";

import Link from "next/link";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { PaperDetailDialog } from "./paper-reading-app";
import type {
  PaperLibraryEntry,
  PaperRecord,
  PaperTopic,
  PaperUserState,
  ReadingAction,
  Relevance,
  SourceScope,
} from "./types";
import baseStyles from "./paper-reading.module.css";
import styles from "./paper-library.module.css";

const PAGE_SIZE = 24;
const storageKey = "zhy-paper-reading-state-v1";
const stateChangeEvent = "zhy-paper-reading-state-change";

type TimeRange = "all" | "7d" | "30d" | "90d" | "365d";
type CodeFilter = "all" | "yes" | "no";
type SortMode =
  | "collectedAt-desc"
  | "publishedAt-desc"
  | "updatedAt-desc"
  | "relevance-desc";
type FilterName =
  | "topic"
  | "time"
  | "venue"
  | "scope"
  | "method"
  | "code"
  | "relevance"
  | "reading"
  | "sort";

type UpgradedIndexField =
  | "primaryTopicId"
  | "identifiers"
  | "venueIds"
  | "facets"
  | "publicationType"
  | "collectedAt"
  | "firstReportedDate"
  | "lastReportedDate"
  | "digestDates"
  | "paperHref"
  | "codeHref"
  | "hasCode"
  | "keywords"
  | "categories"
  | "updatedAt";

type LibraryPaperEntry = Omit<PaperLibraryEntry, UpgradedIndexField> &
  Partial<Pick<PaperLibraryEntry, UpgradedIndexField>>;

type LibraryMeta = {
  schemaVersion?: number;
  generatedAt?: string;
  topics?: {
    id: string;
    label?: string;
    labelZh?: string;
    labelEn?: string;
    shortLabel?: string;
    accent?: string;
  }[];
  venues?: {
    id: string;
    label?: string;
    name?: string;
    displayName?: string;
    shortLabel?: string;
  }[];
  facetDimensions?: {
    id: string;
    labelZh?: string;
    values: { id: string; label?: string; labelZh?: string }[];
  }[];
};

type FilterOption = {
  value: string;
  label: string;
  count?: number;
};

const relevanceLabels: Record<Relevance, string> = {
  high: "高相关",
  medium: "中相关",
  low: "低相关",
};

const readingActionLabels: Record<ReadingAction, string> = {
  deep: "精读",
  skim: "略读",
  skip: "暂不读",
};

const sourceLabels: Record<SourceScope, string> = {
  full_text: "Full text",
  abstract: "Abstract only",
  metadata: "Metadata only",
};

const relevanceValues = new Set<Relevance>(["high", "medium", "low"]);
const readingActionValues = new Set<ReadingAction>(["deep", "skim", "skip"]);
const timeValues = new Set<TimeRange>(["all", "7d", "30d", "90d", "365d"]);
const codeValues = new Set<CodeFilter>(["all", "yes", "no"]);
const sortValues = new Set<SortMode>([
  "collectedAt-desc",
  "publishedAt-desc",
  "updatedAt-desc",
  "relevance-desc",
]);

const timeOptions: FilterOption[] = [
  { value: "all", label: "全部时间" },
  { value: "7d", label: "最近 7 天" },
  { value: "30d", label: "最近 30 天" },
  { value: "90d", label: "最近 90 天" },
  { value: "365d", label: "最近一年" },
];

const codeOptions: FilterOption[] = [
  { value: "all", label: "全部" },
  { value: "yes", label: "有 Code" },
  { value: "no", label: "暂无 Code" },
];

const relevanceOptions: FilterOption[] = [
  { value: "all", label: "全部" },
  { value: "high", label: "高相关" },
  { value: "medium", label: "中相关" },
  { value: "low", label: "低相关" },
];

const readingOptions: FilterOption[] = [
  { value: "all", label: "全部" },
  { value: "deep", label: "精读" },
  { value: "skim", label: "略读" },
  { value: "skip", label: "暂不读" },
];

const sortOptions: FilterOption[] = [
  { value: "collectedAt-desc", label: "最近收录" },
  { value: "publishedAt-desc", label: "最新发表" },
  { value: "updatedAt-desc", label: "最近更新" },
  { value: "relevance-desc", label: "相关性" },
];

function normalizeSearch(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function uniqueStrings(values: (string | undefined)[]) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function getCollectedDate(entry: LibraryPaperEntry) {
  return entry.collectedAt || entry.firstReportedDate || entry.digestDates?.[0] || null;
}

function getShanghaiDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function hasCode(entry: LibraryPaperEntry) {
  return entry.hasCode ?? Boolean(entry.codeHref);
}

function getVenueKeys(entry: LibraryPaperEntry) {
  if (entry.venueIds?.length) return entry.venueIds;
  return [`legacy:${entry.venue}`];
}

function getFacetValues(entry: LibraryPaperEntry, dimensionId: string) {
  const values = entry.facets?.[dimensionId];
  return Array.isArray(values) ? values : [];
}

function getSearchText(entry: LibraryPaperEntry) {
  return normalizeSearch(
    [
      entry.title,
      entry.authors.join(" "),
      entry.keywords?.join(" ") || "",
      entry.venue,
      entry.ideaZh,
    ].join(" "),
  );
}

function formatAuthors(authors: string[], limit = 3) {
  if (authors.length <= limit) return authors.join(", ");
  return `${authors.slice(0, limit).join(", ")} et al.`;
}

function sortAndDedupeEntries(rawEntries: LibraryPaperEntry[]) {
  const byId = new Map<string, LibraryPaperEntry>();

  rawEntries.forEach((entry) => {
    if (!entry?.id || !entry.slug || !entry.title) return;
    const previous = byId.get(entry.id);
    if (!previous) {
      byId.set(entry.id, entry);
      return;
    }

    const firstDates = [previous.firstReportedDate, entry.firstReportedDate].filter(
      (date): date is string => Boolean(date),
    );
    const lastDates = [previous.lastReportedDate, entry.lastReportedDate].filter(
      (date): date is string => Boolean(date),
    );
    byId.set(entry.id, {
      ...previous,
      ...entry,
      topicIds: uniqueStrings([...previous.topicIds, ...entry.topicIds]),
      venueIds: uniqueStrings([...(previous.venueIds || []), ...(entry.venueIds || [])]),
      keywords: uniqueStrings([...(previous.keywords || []), ...(entry.keywords || [])]),
      categories: uniqueStrings([...(previous.categories || []), ...(entry.categories || [])]),
      digestDates: uniqueStrings([...(previous.digestDates || []), ...(entry.digestDates || [])]).sort(),
      firstReportedDate: firstDates.sort()[0] || null,
      lastReportedDate: lastDates.sort().at(-1) || null,
    });
  });

  return Array.from(byId.values()).sort((left, right) => {
    const byCollection = (getCollectedDate(right) || "").localeCompare(
      getCollectedDate(left) || "",
    );
    if (byCollection) return byCollection;
    const byPublication = right.publishedAt.localeCompare(left.publishedAt);
    return byPublication || left.title.localeCompare(right.title);
  });
}

function subscribeToPaperState(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(stateChangeEvent, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(stateChangeEvent, callback);
  };
}

function getPaperStateSnapshot() {
  try {
    return window.localStorage.getItem(storageKey) || "{}";
  } catch {
    return "{}";
  }
}

function getServerPaperStateSnapshot() {
  return "{}";
}

function parsePaperStates(serialized: string) {
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => Boolean(value) && typeof value === "object" && !Array.isArray(value))
        .map(([paperId, value]) => {
          const state = { ...(value as PaperUserState) };
          if (!relevanceValues.has(state.relevance as Relevance)) delete state.relevance;
          if (!readingActionValues.has(state.readingAction as ReadingAction)) {
            delete state.readingAction;
          }
          return [paperId, state];
        }),
    ) as Record<string, PaperUserState>;
  } catch {
    return {};
  }
}

function FilterDropdown({
  id,
  label,
  value,
  options,
  open,
  onToggle,
  onChange,
}: {
  id: FilterName;
  label: string;
  value: string;
  options: FilterOption[];
  open: boolean;
  onToggle: () => void;
  onChange: (value: string) => void;
}) {
  const selected = options.find((option) => option.value === value) || options[0];
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const focusOption = useCallback((requestedIndex: number) => {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') || [],
    );
    if (!buttons.length) return;
    const index = Math.max(0, Math.min(requestedIndex, buttons.length - 1));
    buttons[index]?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = Math.max(
      0,
      options.findIndex((option) => option.value === value),
    );
    const frame = window.requestAnimationFrame(() => focusOption(selectedIndex));
    return () => window.cancelAnimationFrame(frame);
  }, [focusOption, open, options, value]);

  const closeAndRestoreFocus = useCallback(() => {
    onToggle();
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, [onToggle]);

  return (
    <div className={styles.filterMenu} data-open={open ? "true" : "false"}>
      <button
        className={styles.filterTrigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-filter-options`}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          if (!open) onToggle();
          const targetIndex =
            event.key === "ArrowUp"
              ? options.length - 1
              : Math.max(
                  0,
                  options.findIndex((option) => option.value === value),
                );
          window.requestAnimationFrame(() => focusOption(targetIndex));
        }}
        ref={triggerRef}
      >
        <span>{label}</span>
        <strong>{selected?.label}</strong>
        <i aria-hidden="true" />
      </button>
      {open ? (
        <div
          className={styles.filterPopover}
          id={`${id}-filter-options`}
          role="listbox"
          ref={menuRef}
          onKeyDown={(event) => {
            const buttons = Array.from(
              menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') || [],
            );
            const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeAndRestoreFocus();
            } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              if (event.key === "Home") focusOption(0);
              else if (event.key === "End") focusOption(buttons.length - 1);
              else if (event.key === "ArrowDown") {
                focusOption(currentIndex < 0 ? 0 : (currentIndex + 1) % buttons.length);
              } else {
                focusOption(
                  currentIndex < 0
                    ? buttons.length - 1
                    : (currentIndex - 1 + buttons.length) % buttons.length,
                );
              }
            }
          }}
        >
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                onChange(option.value);
                window.requestAnimationFrame(() => triggerRef.current?.focus());
              }}
              key={option.value}
            >
              <span>{option.label}</span>
              {option.count !== undefined ? <small>{option.count}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MobileOptionGroup({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
}) {
  return (
    <fieldset className={styles.mobileOptionGroup}>
      <legend>{label}</legend>
      <div>
        {options.map((option) => (
          <button
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            key={option.value}
          >
            {option.label}
            {option.count !== undefined ? <small>{option.count}</small> : null}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function MobileFilterSheet({
  open,
  activeCount,
  groups,
  onClose,
  onReset,
}: {
  open: boolean;
  activeCount: number;
  groups: {
    label: string;
    value: string;
    options: FilterOption[];
    onChange: (value: string) => void;
  }[];
  onClose: () => void;
  onReset: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (!dialog.open) dialog.showModal();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
    };
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      className={styles.mobileFilterDialog}
      ref={dialogRef}
      aria-labelledby="mobile-filter-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className={styles.mobileFilterSurface}>
        <header>
          <div>
            <span>Filters</span>
            <h2 id="mobile-filter-title">筛选论文</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭筛选">
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className={styles.mobileFilterBody}>
          {groups.map((group) => (
            <MobileOptionGroup {...group} key={group.label} />
          ))}
        </div>
        <footer>
          <button type="button" onClick={onReset} disabled={!activeCount}>
            清除筛选{activeCount ? ` · ${activeCount}` : ""}
          </button>
          <button type="button" onClick={onClose}>
            查看结果
          </button>
        </footer>
      </section>
    </dialog>
  );
}

function StateButton({
  active,
  label,
  activeLabel,
  glyph,
  onClick,
}: {
  active: boolean;
  label: string;
  activeLabel: string;
  glyph: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`${baseStyles.stateButton} ${active ? baseStyles.stateButtonActive : ""}`}
      type="button"
      aria-pressed={active}
      onClick={onClick}
    >
      <span aria-hidden="true">{glyph}</span>
      {active ? activeLabel : label}
    </button>
  );
}

function LibraryPaperCard({
  entry,
  topics,
  userState,
  loading,
  onOpen,
  updateUserState,
}: {
  entry: LibraryPaperEntry;
  topics: PaperTopic[];
  userState: PaperUserState;
  loading: boolean;
  onOpen: () => void;
  updateUserState: (patch: Partial<PaperUserState>) => void;
}) {
  const primaryTopic = topics.find(
    (topic) => topic.id === (entry.primaryTopicId || entry.topicIds[0]),
  );
  const relevance = userState.relevance || entry.relevance;
  const readingAction = userState.readingAction || entry.readingAction;
  const collectedDate = getCollectedDate(entry);

  return (
    <article
      className={`${baseStyles.paperCard} ${styles.libraryCard}`}
      data-accent={primaryTopic?.accent || "teal"}
      id={entry.slug}
      aria-busy={loading}
    >
      <button
        className={baseStyles.cardOpenOverlay}
        type="button"
        aria-label={`打开 ${entry.title} 的解读`}
        onClick={onOpen}
      />
      <div className={baseStyles.cardAccent} aria-hidden="true" />
      <div className={baseStyles.paperBody}>
        <div className={baseStyles.paperMetaRow}>
          <div className={baseStyles.badgeRow}>
            {entry.topicIds.map((topicId) => {
              const topic = topics.find((candidate) => candidate.id === topicId);
              return topic ? (
                <span
                  className={baseStyles.topicBadge}
                  data-accent={topic.accent}
                  key={topic.id}
                >
                  {topic.shortLabel}
                </span>
              ) : (
                <span className={baseStyles.neutralBadge} key={topicId}>
                  {topicId}
                </span>
              );
            })}
            <span className={baseStyles.neutralBadge}>{sourceLabels[entry.sourceScope]}</span>
          </div>
          <div className={styles.cardDates} aria-label="论文时间">
            {collectedDate ? (
              <time dateTime={collectedDate}>收录 {collectedDate}</time>
            ) : (
              <span>收录时间未知</span>
            )}
            {entry.updatedAt && entry.updatedAt !== entry.publishedAt ? (
              <time dateTime={entry.updatedAt}>更新 {entry.updatedAt}</time>
            ) : null}
            <time dateTime={entry.publishedAt}>发表 {entry.publishedAt}</time>
          </div>
        </div>
        <h3>{entry.title}</h3>
        <p className={baseStyles.authors}>{formatAuthors(entry.authors)}</p>
        <p className={styles.venueLine}>{entry.venue}</p>
        <p className={baseStyles.cardIdea}>{entry.ideaZh}</p>
        <div className={baseStyles.systemJudgements} aria-label="阅读建议">
          <span data-tone={relevance} data-overridden={Boolean(userState.relevance)}>
            {userState.relevance ? "我的 · " : ""}
            {relevanceLabels[relevance]}
          </span>
          <span data-overridden={Boolean(userState.readingAction)}>
            {userState.readingAction ? "我的 · " : ""}
            {readingActionLabels[readingAction]}
          </span>
        </div>
        <div className={baseStyles.cardFooter}>
          <div className={baseStyles.cardSourceLinks} aria-label="论文来源">
            {entry.paperHref ? (
              <a href={entry.paperHref} target="_blank" rel="noreferrer">
                Paper <span aria-hidden="true">↗</span>
              </a>
            ) : null}
            {entry.codeHref ? (
              <a href={entry.codeHref} target="_blank" rel="noreferrer">
                Code <span aria-hidden="true">↗</span>
              </a>
            ) : null}
          </div>
          <div className={baseStyles.compactActions}>
            <StateButton
              active={Boolean(userState.starred)}
              label="收藏"
              activeLabel="已收藏"
              glyph="★"
              onClick={() => updateUserState({ starred: !userState.starred })}
            />
            <StateButton
              active={Boolean(userState.readLater)}
              label="稍后读"
              activeLabel="待读"
              glyph="◷"
              onClick={() => updateUserState({ readLater: !userState.readLater })}
            />
          </div>
        </div>
      </div>
      {loading ? <span className={styles.cardLoading}>正在打开…</span> : null}
    </article>
  );
}

export function PaperLibraryApp({ topics: initialTopics }: { topics: PaperTopic[] }) {
  const [entries, setEntries] = useState<LibraryPaperEntry[] | null>(null);
  const [meta, setMeta] = useState<LibraryMeta | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loadVersion, setLoadVersion] = useState(0);
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState("all");
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [venue, setVenue] = useState("all");
  const [contentScope, setContentScope] = useState("all");
  const [method, setMethod] = useState("all");
  const [code, setCode] = useState<CodeFilter>("all");
  const [relevance, setRelevance] = useState("all");
  const [reading, setReading] = useState("all");
  const [sortMode, setSortMode] = useState<SortMode>("collectedAt-desc");
  const [openFilter, setOpenFilter] = useState<FilterName | null>(null);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [pagination, setPagination] = useState({ key: "", count: PAGE_SIZE });
  const [urlReady, setUrlReady] = useState(false);
  const [openPaper, setOpenPaper] = useState<PaperRecord | null>(null);
  const [paperCache, setPaperCache] = useState<Record<string, PaperRecord>>({});
  const [loadingPaperId, setLoadingPaperId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState("");
  const [storageError, setStorageError] = useState(false);
  const filterBarRef = useRef<HTMLDivElement>(null);
  const sortControlRef = useRef<HTMLDivElement>(null);
  const deferredQuery = useDeferredValue(query);

  const serializedPaperStates = useSyncExternalStore(
    subscribeToPaperState,
    getPaperStateSnapshot,
    getServerPaperStateSnapshot,
  );
  const paperStates = useMemo(
    () => parsePaperStates(serializedPaperStates),
    [serializedPaperStates],
  );

  useEffect(() => {
    const controller = new AbortController();

    async function loadLibrary() {
      try {
        const indexResponse = await fetch("/paper-reading/data/paper-index.json", {
          signal: controller.signal,
        });
        if (!indexResponse.ok) throw new Error(`HTTP ${indexResponse.status}`);
        const rawEntries = (await indexResponse.json()) as LibraryPaperEntry[];
        setLoadError("");
        setEntries(sortAndDedupeEntries(Array.isArray(rawEntries) ? rawEntries : []));

        try {
          const metaResponse = await fetch("/paper-reading/data/library-meta.json", {
            signal: controller.signal,
          });
          if (metaResponse.ok) setMeta((await metaResponse.json()) as LibraryMeta);
        } catch (error: unknown) {
          if (error instanceof DOMException && error.name === "AbortError") return;
          // Older feeds do not include library-meta.json; index-derived options remain usable.
        }
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoadError("论文索引暂时无法加载，请稍后重试。");
      }
    }

    void loadLibrary();
    return () => controller.abort();
  }, [loadVersion]);

  useEffect(() => {
    function applyUrl() {
      const params = new URLSearchParams(window.location.search);
      const nextTime = params.get("time") as TimeRange | null;
      const nextCode = params.get("code") as CodeFilter | null;
      const nextSort = params.get("sort") as SortMode | null;
      const nextRelevance = params.get("relevance") || "all";
      const nextReading = params.get("reading") || "all";
      setQuery(params.get("q") || "");
      setTopic(params.get("topic") || "all");
      setTimeRange(nextTime && timeValues.has(nextTime) ? nextTime : "all");
      setVenue(params.get("venue") || "all");
      setContentScope(params.get("scope") || "all");
      setMethod(params.get("method") || "all");
      setCode(nextCode && codeValues.has(nextCode) ? nextCode : "all");
      setSortMode(
        nextSort && sortValues.has(nextSort) ? nextSort : "collectedAt-desc",
      );
      setRelevance(
        nextRelevance === "all" || relevanceValues.has(nextRelevance as Relevance)
          ? nextRelevance
          : "all",
      );
      setReading(
        nextReading === "all" || readingActionValues.has(nextReading as ReadingAction)
          ? nextReading
          : "all",
      );
      setUrlReady(true);
    }

    applyUrl();
    window.addEventListener("popstate", applyUrl);
    return () => window.removeEventListener("popstate", applyUrl);
  }, []);

  useEffect(() => {
    if (!urlReady) return;
    const url = new URL(window.location.href);
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (topic !== "all") params.set("topic", topic);
    if (timeRange !== "all") params.set("time", timeRange);
    if (venue !== "all") params.set("venue", venue);
    if (contentScope !== "all") params.set("scope", contentScope);
    if (method !== "all") params.set("method", method);
    if (code !== "all") params.set("code", code);
    if (relevance !== "all") params.set("relevance", relevance);
    if (reading !== "all") params.set("reading", reading);
    if (sortMode !== "collectedAt-desc") params.set("sort", sortMode);
    const nextSearch = params.toString();
    const nextUrl = `${url.pathname}${nextSearch ? `?${nextSearch}` : ""}${url.hash}`;
    window.history.replaceState(null, "", nextUrl);
  }, [
    code,
    contentScope,
    method,
    query,
    reading,
    relevance,
    sortMode,
    timeRange,
    topic,
    urlReady,
    venue,
  ]);

  useEffect(() => {
    if (!openFilter) return;
    function closeOnOutsidePress(event: PointerEvent) {
      const target = event.target as Node;
      if (
        !filterBarRef.current?.contains(target) &&
        !sortControlRef.current?.contains(target)
      ) {
        setOpenFilter(null);
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenFilter(null);
    }
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openFilter]);

  const topics = useMemo(() => {
    const merged = [...initialTopics];
    meta?.topics?.forEach((candidate) => {
      if (!candidate.id || merged.some((topicItem) => topicItem.id === candidate.id)) return;
      const accent = ["teal", "blue", "amber", "violet", "rose"].includes(
        candidate.accent || "",
      )
        ? (candidate.accent as PaperTopic["accent"])
        : "teal";
      merged.push({
        id: candidate.id,
        labelZh: candidate.labelZh || candidate.label || candidate.shortLabel || candidate.id,
        labelEn: candidate.labelEn || candidate.label || candidate.shortLabel || candidate.id,
        shortLabel: candidate.shortLabel || candidate.labelZh || candidate.label || candidate.id,
        descriptionZh: "",
        accent,
      });
    });
    return merged;
  }, [initialTopics, meta]);

  const topicOptions = useMemo<FilterOption[]>(() => {
    const source = entries || [];
    const knownTopics = [...topics];
    source.forEach((entry) => {
      entry.topicIds.forEach((topicId) => {
        if (knownTopics.some((candidate) => candidate.id === topicId)) return;
        knownTopics.push({
          id: topicId,
          labelZh: topicId,
          labelEn: topicId,
          shortLabel: topicId,
          descriptionZh: "",
          accent: "teal",
        });
      });
    });
    return [
      { value: "all", label: "全部方向", count: source.length },
      ...knownTopics.map((topicItem) => ({
        value: topicItem.id,
        label: topicItem.shortLabel,
        count: source.filter((entry) => entry.topicIds.includes(topicItem.id)).length,
      })),
    ];
  }, [entries, topics]);

  const venueOptions = useMemo<FilterOption[]>(() => {
    const source = entries || [];
    const usedKeys = new Set(source.flatMap(getVenueKeys));
    const labels = new Map<string, string>();
    meta?.venues?.forEach((item) => {
      if (item.id) {
        labels.set(
          item.id,
          item.shortLabel || item.displayName || item.name || item.label || item.id,
        );
      }
    });
    source.forEach((entry) => {
      getVenueKeys(entry).forEach((key) => {
        if (!labels.has(key)) labels.set(key, entry.venue || key.replace(/^legacy:/, ""));
      });
    });
    return [
      { value: "all", label: "全部 Venue", count: source.length },
      ...Array.from(usedKeys)
        .map((key) => ({
          value: key,
          label: labels.get(key) || key,
          count: source.filter((entry) => getVenueKeys(entry).includes(key)).length,
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    ];
  }, [entries, meta]);

  const buildFacetOptions = useCallback(
    (dimensionId: string, allLabel: string): FilterOption[] => {
      const source = entries || [];
      const dimension = meta?.facetDimensions?.find((item) => item.id === dimensionId);
      const labels = new Map(
        (dimension?.values || []).map((value) => [
          value.id,
          value.labelZh || value.label || value.id,
        ]),
      );
      const usedValues = new Set(source.flatMap((entry) => getFacetValues(entry, dimensionId)));
      return [
        { value: "all", label: allLabel, count: source.length },
        ...Array.from(usedValues)
          .map((value) => ({
            value,
            label: labels.get(value) || value,
            count: source.filter((entry) => getFacetValues(entry, dimensionId).includes(value))
              .length,
          }))
          .sort((left, right) => left.label.localeCompare(right.label)),
      ];
    },
    [entries, meta],
  );

  const contentScopeOptions = useMemo(
    () => buildFacetOptions("content-scope", "全部尺度"),
    [buildFacetOptions],
  );
  const methodOptions = useMemo(
    () => buildFacetOptions("method", "全部方法"),
    [buildFacetOptions],
  );

  useEffect(() => {
    if (!entries || !urlReady) return;
    const hasValue = (options: FilterOption[], value: string) =>
      options.some((option) => option.value === value);
    const invalid = {
      topic: !hasValue(topicOptions, topic),
      venue: !hasValue(venueOptions, venue),
      contentScope: !hasValue(contentScopeOptions, contentScope),
      method: !hasValue(methodOptions, method),
    };
    if (!Object.values(invalid).some(Boolean)) return;
    const frame = window.requestAnimationFrame(() => {
      if (invalid.topic) setTopic("all");
      if (invalid.venue) setVenue("all");
      if (invalid.contentScope) setContentScope("all");
      if (invalid.method) setMethod("all");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    contentScope,
    contentScopeOptions,
    entries,
    method,
    methodOptions,
    topic,
    topicOptions,
    urlReady,
    venue,
    venueOptions,
  ]);

  const todayTimestamp = useMemo(
    () => Date.parse(`${getShanghaiDate()}T12:00:00+08:00`),
    [],
  );
  const filteredEntries = useMemo(() => {
    if (!entries) return [];
    const queryTokens = normalizeSearch(deferredQuery).split(/\s+/).filter(Boolean);
    const rangeDays = timeRange === "all" ? 0 : Number.parseInt(timeRange, 10);

    return entries.filter((entry) => {
      const userState = paperStates[entry.id] || {};
      const effectiveRelevance = userState.relevance || entry.relevance;
      const effectiveReading = userState.readingAction || entry.readingAction;
      const matchesQuery =
        !queryTokens.length || queryTokens.every((token) => getSearchText(entry).includes(token));
      const matchesTopic = topic === "all" || entry.topicIds.includes(topic);
      const matchesVenue = venue === "all" || getVenueKeys(entry).includes(venue);
      const matchesContentScope =
        contentScope === "all" || getFacetValues(entry, "content-scope").includes(contentScope);
      const matchesMethod = method === "all" || getFacetValues(entry, "method").includes(method);
      const matchesCode =
        code === "all" || (code === "yes" ? hasCode(entry) : !hasCode(entry));
      const matchesRelevance = relevance === "all" || effectiveRelevance === relevance;
      const matchesReading = reading === "all" || effectiveReading === reading;
      let matchesTime = true;
      if (rangeDays) {
        const collectedDate = getCollectedDate(entry);
        const collectedTimestamp = collectedDate
          ? Date.parse(`${collectedDate}T12:00:00+08:00`)
          : Number.NaN;
        const elapsed = todayTimestamp - collectedTimestamp;
        matchesTime =
          Number.isFinite(collectedTimestamp) &&
          elapsed >= 0 &&
          elapsed <= (rangeDays - 1) * 86_400_000;
      }
      return (
        matchesQuery &&
        matchesTopic &&
        matchesVenue &&
        matchesContentScope &&
        matchesMethod &&
        matchesCode &&
        matchesRelevance &&
        matchesReading &&
        matchesTime
      );
    });
  }, [
    code,
    contentScope,
    deferredQuery,
    entries,
    method,
    paperStates,
    reading,
    relevance,
    timeRange,
    todayTimestamp,
    topic,
    venue,
  ]);

  const paginationKey = [
    normalizeSearch(deferredQuery),
    topic,
    timeRange,
    venue,
    contentScope,
    method,
    code,
    relevance,
    reading,
    sortMode,
  ].join("\u0000");
  const visibleCount = pagination.key === paginationKey ? pagination.count : PAGE_SIZE;
  const sortedEntries = useMemo(() => {
    const relevanceRank: Record<Relevance, number> = { high: 3, medium: 2, low: 1 };
    const compareCollectionDate = (left: LibraryPaperEntry, right: LibraryPaperEntry) =>
      (getCollectedDate(right) || "").localeCompare(getCollectedDate(left) || "");
    const comparePublishedDate = (left: LibraryPaperEntry, right: LibraryPaperEntry) =>
      right.publishedAt.localeCompare(left.publishedAt);
    const compareUpdatedDate = (left: LibraryPaperEntry, right: LibraryPaperEntry) =>
      (right.updatedAt || right.publishedAt).localeCompare(
        left.updatedAt || left.publishedAt,
      );

    return [...filteredEntries].sort((left, right) => {
      let order = 0;
      if (sortMode === "publishedAt-desc") order = comparePublishedDate(left, right);
      else if (sortMode === "updatedAt-desc") order = compareUpdatedDate(left, right);
      else if (sortMode === "relevance-desc") {
        const leftRelevance = paperStates[left.id]?.relevance || left.relevance;
        const rightRelevance = paperStates[right.id]?.relevance || right.relevance;
        order = relevanceRank[rightRelevance] - relevanceRank[leftRelevance];
      } else order = compareCollectionDate(left, right);

      return (
        order ||
        compareCollectionDate(left, right) ||
        comparePublishedDate(left, right) ||
        left.title.localeCompare(right.title)
      );
    });
  }, [filteredEntries, paperStates, sortMode]);
  const visibleEntries = sortedEntries.slice(0, visibleCount);

  const activeFilterCount = [
    topic,
    timeRange,
    venue,
    contentScope,
    method,
    code,
    relevance,
    reading,
  ].filter((value) => value !== "all").length;

  const resetFilters = useCallback(() => {
    setTopic("all");
    setTimeRange("all");
    setVenue("all");
    setContentScope("all");
    setMethod("all");
    setCode("all");
    setRelevance("all");
    setReading("all");
  }, []);

  const updatePaperState = useCallback(
    (paperId: string, patch: Partial<PaperUserState>) => {
      const currentState = paperStates[paperId] || {};
      const timestampedPatch = { ...patch };
      const now = new Date().toISOString();
      if (patch.starred !== undefined) {
        timestampedPatch.starredAt = patch.starred ? now : undefined;
      }
      if (patch.readLater !== undefined) {
        timestampedPatch.readLaterAt = patch.readLater ? now : undefined;
      }
      const next = {
        ...paperStates,
        [paperId]: { ...currentState, ...timestampedPatch },
      };
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
        window.dispatchEvent(new Event(stateChangeEvent));
        setStorageError(false);
      } catch {
        setStorageError(true);
      }
    },
    [paperStates],
  );

  const openEntry = useCallback(
    async (entry: LibraryPaperEntry, updateHash = true) => {
      setDetailError("");
      if (updateHash) {
        const url = new URL(window.location.href);
        window.history.replaceState(
          null,
          "",
          `${url.pathname}${url.search}#${entry.slug}`,
        );
      }
      const cached = paperCache[entry.id];
      if (cached) {
        setOpenPaper(cached);
        return;
      }
      setLoadingPaperId(entry.id);
      try {
        const response = await fetch(`/paper-reading/data/papers/${entry.slug}.json`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const paper = (await response.json()) as PaperRecord;
        setPaperCache((current) => ({ ...current, [paper.id]: paper }));
        setOpenPaper(paper);
      } catch {
        setDetailError("这篇论文的详细解读暂时无法加载。");
      } finally {
        setLoadingPaperId(null);
      }
    },
    [paperCache],
  );

  useEffect(() => {
    if (!entries?.length) return;
    const slug = window.location.hash.slice(1);
    if (!slug || openPaper?.slug === slug) return;
    const entry = entries.find((candidate) => candidate.slug === slug);
    if (!entry) return;
    const frame = window.requestAnimationFrame(() => void openEntry(entry, false));
    return () => window.cancelAnimationFrame(frame);
  }, [entries, openEntry, openPaper?.slug]);

  const closePaper = useCallback(() => {
    setOpenPaper(null);
    const url = new URL(window.location.href);
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }, []);

  const selectedLabels = {
    topic: topicOptions.find((option) => option.value === topic)?.label || topic,
    time: timeOptions.find((option) => option.value === timeRange)?.label || timeRange,
    venue: venueOptions.find((option) => option.value === venue)?.label || venue,
    scope:
      contentScopeOptions.find((option) => option.value === contentScope)?.label || contentScope,
    method: methodOptions.find((option) => option.value === method)?.label || method,
    code: codeOptions.find((option) => option.value === code)?.label || code,
    relevance: relevanceOptions.find((option) => option.value === relevance)?.label || relevance,
    reading: readingOptions.find((option) => option.value === reading)?.label || reading,
  };

  const activeChips = [
    topic !== "all" ? { key: "topic", label: selectedLabels.topic, clear: () => setTopic("all") } : null,
    timeRange !== "all"
      ? { key: "time", label: selectedLabels.time, clear: () => setTimeRange("all") }
      : null,
    venue !== "all" ? { key: "venue", label: selectedLabels.venue, clear: () => setVenue("all") } : null,
    contentScope !== "all"
      ? { key: "scope", label: selectedLabels.scope, clear: () => setContentScope("all") }
      : null,
    method !== "all"
      ? { key: "method", label: selectedLabels.method, clear: () => setMethod("all") }
      : null,
    code !== "all" ? { key: "code", label: selectedLabels.code, clear: () => setCode("all") } : null,
    relevance !== "all"
      ? { key: "relevance", label: selectedLabels.relevance, clear: () => setRelevance("all") }
      : null,
    reading !== "all"
      ? { key: "reading", label: selectedLabels.reading, clear: () => setReading("all") }
      : null,
  ].filter((chip): chip is { key: string; label: string; clear: () => void } => Boolean(chip));

  const mobileGroups = [
    { label: "研究方向", value: topic, options: topicOptions, onChange: setTopic },
    {
      label: "收录时间",
      value: timeRange,
      options: timeOptions,
      onChange: (value: string) => setTimeRange(value as TimeRange),
    },
    { label: "Venue", value: venue, options: venueOptions, onChange: setVenue },
    {
      label: "内容尺度",
      value: contentScope,
      options: contentScopeOptions,
      onChange: setContentScope,
    },
    { label: "方法", value: method, options: methodOptions, onChange: setMethod },
    {
      label: "Code",
      value: code,
      options: codeOptions,
      onChange: (value: string) => setCode(value as CodeFilter),
    },
    { label: "相关性", value: relevance, options: relevanceOptions, onChange: setRelevance },
    { label: "阅读方式", value: reading, options: readingOptions, onChange: setReading },
  ];

  return (
    <main className={baseStyles.paperReading} lang="zh-CN">
      <div className={baseStyles.backgroundGlow} aria-hidden="true" />
      <div className={baseStyles.shell}>
        <header className={baseStyles.pageHeader}>
          <div className={baseStyles.brandRow}>
            <Link className={baseStyles.homeLink} href="/">
              <span aria-hidden="true">←</span> ZHENG Hanyou
            </Link>
            <p className={baseStyles.radarMark}>Personal Research Radar</p>
          </div>
          <h1>Paper Reading</h1>
          <nav className={baseStyles.viewSwitcher} aria-label="Paper Reading 视图">
            <Link href="/paper_reading/daily/">Daily</Link>
            <Link href="/paper_reading/library/" aria-current="page">
              Library
            </Link>
          </nav>
        </header>

        <section className={styles.libraryHeading} aria-labelledby="library-title">
          <div>
            <span>All papers</span>
            <h2 id="library-title">全部论文</h2>
          </div>
          <p>
            <strong>{entries?.length ?? "—"}</strong>
            <span>篇去重收录</span>
          </p>
        </section>

        <section className={styles.filterDeck} aria-label="全部论文筛选">
          <label className={styles.librarySearch}>
            <span className={styles.searchIcon} aria-hidden="true" />
            <span className={baseStyles.srOnly}>搜索标题、作者、关键词、Venue 或核心 idea</span>
            <input
              type="search"
              inputMode="search"
              autoComplete="off"
              placeholder="搜索标题、作者、关键词、Venue 或核心 idea"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <button type="button" onClick={() => setQuery("")} aria-label="清除搜索">
                <span aria-hidden="true">×</span>
              </button>
            ) : null}
          </label>

          <div className={styles.desktopFilters} ref={filterBarRef}>
            <FilterDropdown
              id="topic"
              label="方向"
              value={topic}
              options={topicOptions}
              open={openFilter === "topic"}
              onToggle={() => setOpenFilter((current) => (current === "topic" ? null : "topic"))}
              onChange={(value) => {
                setTopic(value);
                setOpenFilter(null);
              }}
            />
            <FilterDropdown
              id="time"
              label="收录时间"
              value={timeRange}
              options={timeOptions}
              open={openFilter === "time"}
              onToggle={() => setOpenFilter((current) => (current === "time" ? null : "time"))}
              onChange={(value) => {
                setTimeRange(value as TimeRange);
                setOpenFilter(null);
              }}
            />
            <FilterDropdown
              id="venue"
              label="Venue"
              value={venue}
              options={venueOptions}
              open={openFilter === "venue"}
              onToggle={() => setOpenFilter((current) => (current === "venue" ? null : "venue"))}
              onChange={(value) => {
                setVenue(value);
                setOpenFilter(null);
              }}
            />
            <FilterDropdown
              id="scope"
              label="内容尺度"
              value={contentScope}
              options={contentScopeOptions}
              open={openFilter === "scope"}
              onToggle={() => setOpenFilter((current) => (current === "scope" ? null : "scope"))}
              onChange={(value) => {
                setContentScope(value);
                setOpenFilter(null);
              }}
            />
            <FilterDropdown
              id="method"
              label="方法"
              value={method}
              options={methodOptions}
              open={openFilter === "method"}
              onToggle={() => setOpenFilter((current) => (current === "method" ? null : "method"))}
              onChange={(value) => {
                setMethod(value);
                setOpenFilter(null);
              }}
            />
            <FilterDropdown
              id="code"
              label="Code"
              value={code}
              options={codeOptions}
              open={openFilter === "code"}
              onToggle={() => setOpenFilter((current) => (current === "code" ? null : "code"))}
              onChange={(value) => {
                setCode(value as CodeFilter);
                setOpenFilter(null);
              }}
            />
            <FilterDropdown
              id="relevance"
              label="相关性"
              value={relevance}
              options={relevanceOptions}
              open={openFilter === "relevance"}
              onToggle={() =>
                setOpenFilter((current) => (current === "relevance" ? null : "relevance"))
              }
              onChange={(value) => {
                setRelevance(value);
                setOpenFilter(null);
              }}
            />
            <FilterDropdown
              id="reading"
              label="阅读方式"
              value={reading}
              options={readingOptions}
              open={openFilter === "reading"}
              onToggle={() =>
                setOpenFilter((current) => (current === "reading" ? null : "reading"))
              }
              onChange={(value) => {
                setReading(value);
                setOpenFilter(null);
              }}
            />
          </div>

          <button
            className={styles.mobileFilterButton}
            type="button"
            onClick={() => setMobileFiltersOpen(true)}
          >
            <span className={styles.filterGlyph} aria-hidden="true" />
            筛选
            {activeFilterCount ? <strong>{activeFilterCount}</strong> : null}
          </button>

          {activeChips.length ? (
            <div className={styles.activeFilters} aria-label="已启用筛选">
              {activeChips.map((chip) => (
                <button type="button" onClick={chip.clear} key={chip.key}>
                  {chip.label} <span aria-hidden="true">×</span>
                </button>
              ))}
              <button className={styles.clearFilters} type="button" onClick={resetFilters}>
                清除筛选
              </button>
            </div>
          ) : null}
        </section>

        {loadError ? (
          <div className={styles.feedbackState} role="alert">
            <strong>无法读取论文索引</strong>
            <p>{loadError}</p>
            <button
              type="button"
              onClick={() => {
                setLoadError("");
                setEntries(null);
                setLoadVersion((version) => version + 1);
              }}
            >
              重新加载
            </button>
          </div>
        ) : null}

        {!entries && !loadError ? (
          <div className={styles.feedbackState} aria-live="polite">
            <strong>正在读取论文索引…</strong>
          </div>
        ) : null}

        {entries && detailError ? (
          <p className={styles.inlineError} role="alert">
            {detailError}
          </p>
        ) : null}
        {storageError ? (
          <p className={styles.inlineError} role="alert">
            当前浏览器无法保存阅读状态。
          </p>
        ) : null}

        {entries ? (
          <section className={styles.paperResults} aria-label="论文结果">
            <div className={styles.resultHeading}>
              <p>
                <strong>{filteredEntries.length}</strong> 篇
                {filteredEntries.length !== entries.length ? ` / 共 ${entries.length} 篇` : ""}
              </p>
              <div className={styles.sortControl} ref={sortControlRef}>
                <FilterDropdown
                  id="sort"
                  label="排序"
                  value={sortMode}
                  options={sortOptions}
                  open={openFilter === "sort"}
                  onToggle={() =>
                    setOpenFilter((current) => (current === "sort" ? null : "sort"))
                  }
                  onChange={(value) => {
                    setSortMode(value as SortMode);
                    setOpenFilter(null);
                  }}
                />
              </div>
            </div>

            {visibleEntries.length ? (
              <div className={`${baseStyles.paperList} ${styles.resultList}`}>
                {visibleEntries.map((entry) => (
                  <LibraryPaperCard
                    entry={entry}
                    topics={topics}
                    userState={paperStates[entry.id] || {}}
                    loading={loadingPaperId === entry.id}
                    onOpen={() => void openEntry(entry)}
                    updateUserState={(patch) => updatePaperState(entry.id, patch)}
                    key={entry.id}
                  />
                ))}
              </div>
            ) : (
              <div className={styles.feedbackState}>
                <strong>{entries.length ? "没有匹配的论文" : "还没有收录论文"}</strong>
                {entries.length ? <p>可以清除搜索词或筛选条件。</p> : null}
                {entries.length ? (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      resetFilters();
                    }}
                  >
                    清除全部条件
                  </button>
                ) : null}
              </div>
            )}

            {visibleEntries.length < filteredEntries.length ? (
              <div className={styles.loadMoreRow}>
                <button
                  type="button"
                  onClick={() =>
                    setPagination({ key: paginationKey, count: visibleCount + PAGE_SIZE })
                  }
                >
                  加载更多
                  <span>
                    {visibleEntries.length} / {filteredEntries.length}
                  </span>
                </button>
              </div>
            ) : null}
          </section>
        ) : null}

        <footer className={baseStyles.footer}>
          <p>Paper Reading · Zheng Hanyou</p>
          <Link href="/paper_reading/daily/">返回 Daily</Link>
        </footer>
      </div>

      <MobileFilterSheet
        open={mobileFiltersOpen}
        activeCount={activeFilterCount}
        groups={mobileGroups}
        onClose={() => setMobileFiltersOpen(false)}
        onReset={resetFilters}
      />

      <PaperDetailDialog
        paper={openPaper}
        topics={topics}
        userState={openPaper ? paperStates[openPaper.id] || {} : {}}
        updateUserState={(patch) => {
          if (openPaper) updatePaperState(openPaper.id, patch);
        }}
        onClose={closePaper}
      />
    </main>
  );
}
