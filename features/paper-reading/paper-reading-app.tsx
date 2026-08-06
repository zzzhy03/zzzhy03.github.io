"use client";

import Image from "next/image";
import Link from "next/link";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { DatePicker } from "./date-picker";
import type {
  DailyDigest,
  EvidenceMaturity,
  PaperReadingDigestBundle,
  PaperReadingDataset,
  PaperLibraryEntry,
  PaperRecord,
  PaperTopic,
  PaperUserState,
  ReadingAction,
  Relevance,
  SourceScope,
} from "@/features/paper-reading/types";
import styles from "./paper-reading.module.css";

const storageKey = "zhy-paper-reading-state-v1";
const stateChangeEvent = "zhy-paper-reading-state-change";

type ReadingListTab = "all" | "starred" | "readLater";
type DigestHistoryMode = "push" | "none";

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

const relevanceValues = new Set<Relevance>(["high", "medium", "low"]);
const readingActionValues = new Set<ReadingAction>(["deep", "skim", "skip"]);

const evidenceLabels: Record<EvidenceMaturity, string> = {
  solid: "证据扎实",
  mixed: "证据有限",
  early: "早期信号",
};

const sourceLabels: Record<SourceScope, string> = {
  full_text: "Full text",
  abstract: "Abstract only",
  metadata: "Metadata only",
};

function formatDate(date: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    timeZone: "Asia/Shanghai",
  }).format(new Date(`${date}T12:00:00+08:00`));
}

function normalizeSearch(value: string) {
  return value.trim().toLocaleLowerCase();
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

function getSearchText(paper: PaperRecord) {
  return [
    paper.title,
    paper.authors.join(" "),
    paper.keywords.join(" "),
    paper.venue,
    paper.abstract,
    paper.analysis.ideaZh,
  ]
    .join(" ")
    .toLocaleLowerCase();
}

function getPrimaryTopic(paper: PaperRecord, topics: PaperTopic[]) {
  return topics.find((topic) => topic.id === paper.topicIds[0]);
}

function formatAuthors(authors: string[], limit = 3) {
  if (authors.length <= limit) return authors.join(", ");
  return `${authors.slice(0, limit).join(", ")} et al.`;
}

function getEffectiveDecisions(
  recommendedRelevance: Relevance,
  recommendedReadingAction: ReadingAction,
  userState: PaperUserState,
) {
  return {
    relevance: userState.relevance ?? recommendedRelevance,
    readingAction: userState.readingAction ?? recommendedReadingAction,
    relevanceOverridden: userState.relevance !== undefined,
    readingActionOverridden: userState.readingAction !== undefined,
  };
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
      className={`${styles.stateButton} ${active ? styles.stateButtonActive : ""}`}
      type="button"
      aria-pressed={active}
      onClick={onClick}
    >
      <span aria-hidden="true">{glyph}</span>
      {active ? activeLabel : label}
    </button>
  );
}

function ChoiceControl({
  label,
  recommendation,
  value,
  options,
  onChange,
}: {
  label: string;
  recommendation?: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <fieldset className={styles.choiceField}>
      <legend>
        <span>{label}</span>
        {recommendation ? <small>推荐：{recommendation}</small> : null}
      </legend>
      <div className={styles.choiceGroup}>
        {options.map((option) => {
          const active = value === option.value;
          return (
            <button
              className={active ? styles.choiceOptionActive : ""}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(option.value)}
              key={option.value}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function MethodFlow({ steps }: { steps: string[] }) {
  const railRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({
    pointerId: -1,
    startX: 0,
    latestX: 0,
    scrollLeft: 0,
    frame: 0,
  });
  const [dragging, setDragging] = useState(false);

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const rail = railRef.current;
    if (
      event.pointerType !== "mouse" ||
      event.button !== 0 ||
      !rail ||
      rail.scrollWidth <= rail.clientWidth
    ) {
      return;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      latestX: event.clientX,
      scrollLeft: rail.scrollLeft,
      frame: 0,
    };
    rail.setPointerCapture(event.pointerId);
    setDragging(true);
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const rail = railRef.current;
    if (!rail || dragRef.current.pointerId !== event.pointerId) return;
    event.preventDefault();
    dragRef.current.latestX = event.clientX;
    if (dragRef.current.frame) return;
    dragRef.current.frame = window.requestAnimationFrame(() => {
      dragRef.current.frame = 0;
      rail.scrollLeft =
        dragRef.current.scrollLeft - (dragRef.current.latestX - dragRef.current.startX);
    });
  }

  function finishDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const rail = railRef.current;
    if (!rail || dragRef.current.pointerId !== event.pointerId) return;
    if (dragRef.current.frame) window.cancelAnimationFrame(dragRef.current.frame);
    rail.scrollLeft = dragRef.current.scrollLeft - (event.clientX - dragRef.current.startX);
    dragRef.current.frame = 0;
    dragRef.current.pointerId = -1;
    if (rail.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId);
    setDragging(false);
  }

  return (
    <div
      className={styles.methodFlow}
      data-dragging={dragging ? "true" : "false"}
      ref={railRef}
      tabIndex={0}
      aria-label={`Method flow: ${steps.join(", then ")}`}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={() => {
        if (dragRef.current.frame) window.cancelAnimationFrame(dragRef.current.frame);
        dragRef.current.frame = 0;
        dragRef.current.pointerId = -1;
        setDragging(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        railRef.current?.scrollBy({
          left: event.key === "ArrowLeft" ? -180 : 180,
          behavior: "smooth",
        });
      }}
    >
      {steps.map((step, index) => (
        <div className={styles.methodStepWrap} key={`${step}-${index}`}>
          <span className={styles.methodStep}>
            <span className={styles.methodIndex}>{String(index + 1).padStart(2, "0")}</span>
            <span className={styles.methodStepLabel}>{step}</span>
          </span>
          {index < steps.length - 1 ? (
            <span className={styles.methodArrow} aria-hidden="true">
              →
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function PaperArtwork({ paper, compact = false }: { paper: PaperRecord; compact?: boolean }) {
  if (!paper.visual) return null;

  if (compact) {
    return (
      <span className={styles.cardArtwork}>
        <span className={styles.artworkImage}>
          <Image
            src={paper.visual.src}
            alt={paper.visual.alt}
            fill
            sizes="(max-width: 760px) 100vw, 380px"
          />
          {paper.visual.generated ? (
            <span className={styles.generatedLabel}>AI concept</span>
          ) : null}
        </span>
      </span>
    );
  }

  return (
    <figure className={styles.detailArtwork}>
      <div className={styles.artworkImage}>
        <Image
          src={paper.visual.src}
          alt={paper.visual.alt}
          fill
          sizes="(max-width: 760px) 100vw, 920px"
        />
        {paper.visual.generated ? (
          <span className={styles.generatedLabel}>AI concept</span>
        ) : null}
      </div>
      <figcaption>{paper.visual.caption}</figcaption>
    </figure>
  );
}

function TopicBriefs({
  digest,
  topics,
  topicCounts,
  selectedTopic,
}: {
  digest: DailyDigest;
  topics: PaperTopic[];
  topicCounts: Map<string, number>;
  selectedTopic: string;
}) {
  const briefs = digest.topicBriefs.filter(
    (brief) =>
      (topicCounts.get(brief.topicId) || 0) > 0 &&
      (selectedTopic === "all" || brief.topicId === selectedTopic),
  );

  return (
    <section className={styles.digestSection} aria-labelledby="digest-title">
      <div className={styles.digestLead}>
        <div className={styles.digestDateline}>
          <span>Daily brief</span>
          <time dateTime={digest.date}>{formatDate(digest.date)}</time>
        </div>
        <h2 id="digest-title">
          {selectedTopic === "all"
            ? digest.overview.headlineZh
            : briefs[0]?.headlineZh || "今日没有新增论文"}
        </h2>
        {selectedTopic === "all" ? (
          <ul className={styles.digestBullets}>
            {digest.overview.bulletsZh.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </ul>
        ) : (
          <p className={styles.digestSingleSummary}>
            {briefs[0]?.summaryZh || "该方向今日没有新增论文。"}
          </p>
        )}
      </div>

      {selectedTopic === "all" ? (
        <div className={styles.topicBriefGrid}>
          {briefs.map((brief) => {
            const topic = topics.find((item) => item.id === brief.topicId);
            if (!topic) return null;
            return (
              <article className={styles.topicBrief} data-accent={topic.accent} key={brief.topicId}>
                <div className={styles.topicBriefTopline}>
                  <span>{topic.shortLabel}</span>
                  <span>{topicCounts.get(brief.topicId) || 0} 篇</span>
                </div>
                <h3>{brief.headlineZh}</h3>
                <p>{brief.summaryZh}</p>
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function PaperScanCard({
  paper,
  topics,
  userState,
  updateUserState,
  onOpen,
}: {
  paper: PaperRecord;
  topics: PaperTopic[];
  userState: PaperUserState;
  updateUserState: (patch: Partial<PaperUserState>) => void;
  onOpen: () => void;
}) {
  const primaryTopic = getPrimaryTopic(paper, topics);
  const decisions = getEffectiveDecisions(
    paper.analysis.relevance,
    paper.analysis.readingAction,
    userState,
  );

  return (
    <article
      className={styles.paperCard}
      data-accent={primaryTopic?.accent || "teal"}
      data-has-visual={paper.visual ? "true" : "false"}
      id={paper.slug}
    >
      <button
        className={styles.cardOpenOverlay}
        type="button"
        aria-label={`打开 ${paper.title} 的解读`}
        onClick={onOpen}
      />

      {paper.visual ? (
        <PaperArtwork paper={paper} compact />
      ) : (
        <div className={styles.cardAccent} aria-hidden="true" />
      )}

      <div className={styles.paperBody}>
        <div className={styles.paperMetaRow}>
          <div className={styles.badgeRow}>
            {paper.topicIds.map((topicId) => {
              const topic = topics.find((item) => item.id === topicId);
              return topic ? (
                <span className={styles.topicBadge} data-accent={topic.accent} key={topic.id}>
                  {topic.shortLabel}
                </span>
              ) : null;
            })}
            <span className={styles.neutralBadge}>{sourceLabels[paper.analysis.sourceScope]}</span>
          </div>
          <time dateTime={paper.publishedAt}>{paper.publishedAt}</time>
        </div>

        <h3>{paper.title}</h3>
        <p className={styles.authors}>{formatAuthors(paper.authors)}</p>
        <p className={styles.cardIdea}>{paper.analysis.ideaZh}</p>

        <div className={styles.systemJudgements} aria-label="阅读建议">
          <span data-tone={decisions.relevance} data-overridden={decisions.relevanceOverridden}>
            {decisions.relevanceOverridden ? "我的 · " : ""}
            {relevanceLabels[decisions.relevance]}
          </span>
          <span data-overridden={decisions.readingActionOverridden}>
            {decisions.readingActionOverridden ? "我的 · " : ""}
            {readingActionLabels[decisions.readingAction]}
          </span>
          <span>{evidenceLabels[paper.analysis.evidenceMaturity]}</span>
        </div>

        <div className={styles.cardFooter}>
          <div className={styles.cardSourceLinks} aria-label="论文来源">
            {paper.links
              .filter((link) => link.label === "Paper" || link.label === "Code")
              .map((link) => (
                <a
                  href={link.href}
                  target="_blank"
                  rel="noreferrer"
                  key={`${link.label}-${link.href}`}
                >
                  {link.label} <span aria-hidden="true">↗</span>
                </a>
              ))}
          </div>
          <div className={styles.compactActions}>
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
    </article>
  );
}

function ReadingListDrawer({
  open,
  activeTab,
  entries,
  loading,
  error,
  topics,
  paperStates,
  onTabChange,
  onClose,
  onOpenPaper,
  updateUserState,
}: {
  open: boolean;
  activeTab: ReadingListTab;
  entries: PaperLibraryEntry[] | null;
  loading: boolean;
  error: string;
  topics: PaperTopic[];
  paperStates: Record<string, PaperUserState>;
  onTabChange: (tab: ReadingListTab) => void;
  onClose: () => void;
  onOpenPaper: (entry: PaperLibraryEntry) => void;
  updateUserState: (paperId: string, patch: Partial<PaperUserState>) => void;
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

  const allSavedEntries = (entries || []).filter((entry) => {
    const state = paperStates[entry.id];
    return Boolean(state?.starred || state?.readLater);
  });
  const visibleEntries = allSavedEntries
    .filter((entry) => {
      const state = paperStates[entry.id];
      if (activeTab === "starred") return Boolean(state?.starred);
      if (activeTab === "readLater") return Boolean(state?.readLater);
      return true;
    })
    .sort((left, right) => {
      const leftState = paperStates[left.id] || {};
      const rightState = paperStates[right.id] || {};
      const leftTouched = Math.max(
        Date.parse(leftState.starredAt || "") || 0,
        Date.parse(leftState.readLaterAt || "") || 0,
        Date.parse(left.publishedAt) || 0,
      );
      const rightTouched = Math.max(
        Date.parse(rightState.starredAt || "") || 0,
        Date.parse(rightState.readLaterAt || "") || 0,
        Date.parse(right.publishedAt) || 0,
      );
      return rightTouched - leftTouched;
    });
  const counts = {
    all: allSavedEntries.length,
    starred: allSavedEntries.filter((entry) => paperStates[entry.id]?.starred).length,
    readLater: allSavedEntries.filter((entry) => paperStates[entry.id]?.readLater).length,
  };

  return (
    <dialog
      className={styles.libraryDialog}
      ref={dialogRef}
      aria-labelledby="reading-list-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside className={styles.librarySurface}>
        <header className={styles.libraryHeader}>
          <div>
            <span>My library</span>
            <h2 id="reading-list-title">阅读列表</h2>
          </div>
          <button className={styles.closeDialogButton} type="button" onClick={onClose}>
            <span className={styles.srOnly}>关闭阅读列表</span>
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className={styles.libraryTabs} role="tablist" aria-label="阅读列表分类">
          {(
            [
              ["all", "全部"],
              ["starred", "收藏"],
              ["readLater", "稍后读"],
            ] as const
          ).map(([tab, label]) => (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              className={activeTab === tab ? styles.libraryTabActive : ""}
              onClick={() => onTabChange(tab)}
              key={tab}
            >
              {label}
              <span>{counts[tab]}</span>
            </button>
          ))}
        </div>

        <div className={styles.libraryBody}>
          {loading ? <p className={styles.libraryMessage}>正在整理阅读列表…</p> : null}
          {!loading && error ? <p className={styles.libraryError}>{error}</p> : null}
          {!loading && entries && !visibleEntries.length ? (
            <div className={styles.libraryEmpty}>
              <strong>
                {activeTab === "all"
                  ? "阅读列表还是空的"
                  : activeTab === "readLater"
                    ? "还没有稍后读论文"
                    : "还没有收藏论文"}
              </strong>
              <p>在论文卡片或详细解读中加入后，会显示在这里。</p>
            </div>
          ) : null}
          {!loading && entries && visibleEntries.length ? (
            <div className={styles.libraryList}>
              {visibleEntries.map((entry) => {
                const state = paperStates[entry.id] || {};
                const decisions = getEffectiveDecisions(
                  entry.relevance,
                  entry.readingAction,
                  state,
                );
                return (
                  <article className={styles.libraryEntry} key={entry.id}>
                    <button
                      className={styles.libraryEntryMain}
                      type="button"
                      onClick={() => onOpenPaper(entry)}
                    >
                      <div className={styles.libraryEntryTopline}>
                        <div className={styles.badgeRow}>
                          {entry.topicIds.map((topicId) => {
                            const topic = topics.find((item) => item.id === topicId);
                            return topic ? (
                              <span
                                className={styles.topicBadge}
                                data-accent={topic.accent}
                                key={topic.id}
                              >
                                {topic.shortLabel}
                              </span>
                            ) : null;
                          })}
                        </div>
                        <time dateTime={entry.publishedAt}>{entry.publishedAt}</time>
                      </div>
                      <h3>{entry.title}</h3>
                      <p>{formatAuthors(entry.authors, 2)}</p>
                      <div className={styles.libraryDecisions}>
                        <span data-tone={decisions.relevance}>
                          {relevanceLabels[decisions.relevance]}
                        </span>
                        <span>{readingActionLabels[decisions.readingAction]}</span>
                      </div>
                    </button>
                    <div className={styles.libraryEntryActions}>
                      <StateButton
                        active={Boolean(state.starred)}
                        label="收藏"
                        activeLabel="已收藏"
                        glyph="★"
                        onClick={() => updateUserState(entry.id, { starred: !state.starred })}
                      />
                      <StateButton
                        active={Boolean(state.readLater)}
                        label="稍后读"
                        activeLabel="待读"
                        glyph="◷"
                        onClick={() => updateUserState(entry.id, { readLater: !state.readLater })}
                      />
                    </div>
                  </article>
                );
              })}
            </div>
          ) : null}
        </div>

        <p className={styles.libraryStorageNote}>当前阅读状态保存在这个浏览器中。</p>
      </aside>
    </dialog>
  );
}

export function PaperDetailDialog({
  paper,
  topics,
  userState,
  updateUserState,
  onClose,
}: {
  paper: PaperRecord | null;
  topics: PaperTopic[];
  userState: PaperUserState;
  updateUserState: (patch: Partial<PaperUserState>) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!paper || !dialog) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (!dialog.open) dialog.showModal();

    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
    };
  }, [paper]);

  if (!paper) return null;

  const primaryTopic = getPrimaryTopic(paper, topics);

  async function sharePaper() {
    const url = `${window.location.origin}${window.location.pathname}#${paper?.slug}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: paper?.title, text: paper?.analysis.ideaZh, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1800);
    } catch {
      // Cancelling the native share sheet does not change reading state.
    }
  }

  return (
    <dialog
      className={styles.paperDialog}
      ref={dialogRef}
      aria-labelledby="paper-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <article className={styles.dialogSurface}>
        <div className={styles.dialogTopbar}>
          <div className={styles.badgeRow}>
            {paper.topicIds.map((topicId) => {
              const topic = topics.find((item) => item.id === topicId);
              return topic ? (
                <span className={styles.topicBadge} data-accent={topic.accent} key={topic.id}>
                  {topic.shortLabel}
                </span>
              ) : null;
            })}
            <span className={styles.neutralBadge}>{sourceLabels[paper.analysis.sourceScope]}</span>
          </div>
          <button className={styles.closeDialogButton} type="button" onClick={onClose}>
            <span className={styles.srOnly}>关闭论文解读</span>
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <div className={styles.dialogContent}>
          <header className={styles.detailHeader}>
            <p className={styles.detailVenue}>
              {paper.venue} · <time dateTime={paper.publishedAt}>{paper.publishedAt}</time>
            </p>
            <h2 id="paper-dialog-title">{paper.title}</h2>
            <p className={styles.detailAuthors}>{paper.authors.join(", ")}</p>
            <div className={styles.paperLinks} aria-label="论文相关链接">
              {paper.links.map((link) => (
                <a
                  href={link.href}
                  target="_blank"
                  rel="noreferrer"
                  key={`${link.label}-${link.href}`}
                >
                  {link.label} <span aria-hidden="true">↗</span>
                </a>
              ))}
            </div>
          </header>

          {paper.visual ? <PaperArtwork paper={paper} /> : null}

          <section className={styles.ideaBlock}>
            <span>Core idea</span>
            <p>{paper.analysis.ideaZh}</p>
          </section>

          <section className={styles.methodSection}>
            <div className={styles.sectionHeading}>
              <span>Method flow</span>
              <small>{primaryTopic?.shortLabel}</small>
            </div>
            <MethodFlow steps={paper.analysis.methodFlow} />
          </section>

          {paper.analysis.whyRelevantZh || paper.analysis.evidenceZh || paper.analysis.caveatZh ? (
            <div className={styles.quickReadGrid}>
              {paper.analysis.whyRelevantZh ? (
                <section>
                  <div className={styles.quickReadHeading}>
                    <span>相关性依据</span>
                    <small>AI 研判</small>
                  </div>
                  <p>{paper.analysis.whyRelevantZh}</p>
                </section>
              ) : null}
              {paper.analysis.evidenceZh ? (
                <section>
                  <div className={styles.quickReadHeading}>
                    <span>论文证据</span>
                    <small>{sourceLabels[paper.analysis.sourceScope]}</small>
                  </div>
                  <p>{paper.analysis.evidenceZh}</p>
                </section>
              ) : null}
              {paper.analysis.caveatZh ? (
                <section>
                  <div className={styles.quickReadHeading}>
                    <span>限制 / 解读风险</span>
                    <small>AI 审读</small>
                  </div>
                  <p>{paper.analysis.caveatZh}</p>
                </section>
              ) : null}
            </div>
          ) : null}

          <div className={styles.judgementRow}>
            <div className={styles.overrideControls}>
              <ChoiceControl
                label="我的相关性"
                recommendation={relevanceLabels[paper.analysis.relevance]}
                value={userState.relevance || paper.analysis.relevance}
                options={[
                  { value: "high", label: "高" },
                  { value: "medium", label: "中" },
                  { value: "low", label: "低" },
                ]}
                onChange={(value) =>
                  updateUserState({
                    relevance:
                      value === paper.analysis.relevance ? undefined : (value as Relevance),
                  })
                }
              />
              <ChoiceControl
                label="我的阅读方式"
                recommendation={readingActionLabels[paper.analysis.readingAction]}
                value={userState.readingAction || paper.analysis.readingAction}
                options={[
                  { value: "deep", label: "精读" },
                  { value: "skim", label: "略读" },
                  { value: "skip", label: "暂不读" },
                ]}
                onChange={(value) =>
                  updateUserState({
                    readingAction:
                      value === paper.analysis.readingAction
                        ? undefined
                        : (value as ReadingAction),
                  })
                }
              />
            </div>
          </div>

          <div className={styles.cardActions}>
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
            <StateButton
              active={Boolean(userState.read)}
              label="标为已读"
              activeLabel="已读"
              glyph="✓"
              onClick={() => updateUserState({ read: !userState.read })}
            />
            <StateButton
              active={Boolean(userState.archiveRequested)}
              label="归档 Zotero"
              activeLabel="待归档"
              glyph="↗"
              onClick={() =>
                updateUserState({ archiveRequested: !userState.archiveRequested })
              }
            />
            <button className={styles.stateButton} type="button" onClick={sharePaper}>
              <span aria-hidden="true">⌁</span>
              {linkCopied ? "链接已复制" : "分享解读"}
            </button>
          </div>

          <section className={styles.abstractSection}>
            <div className={styles.abstractHeading}>
              <h3>Abstract</h3>
              <a href={paper.abstractSourceUrl} target="_blank" rel="noreferrer">
                arXiv 原文 ↗
              </a>
            </div>
            {paper.abstractIsOriginal ? (
              <p lang="en">{paper.abstract}</p>
            ) : (
              <a
                className={styles.abstractSourceLink}
                href={paper.abstractSourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                Read the author-provided abstract on arXiv <span aria-hidden="true">↗</span>
              </a>
            )}
          </section>

          <div className={styles.analysisGrid}>
            <section>
              <h3>Motivation</h3>
              <p>{paper.analysis.motivationZh}</p>
            </section>
            <section>
              <h3>Method</h3>
              <p>{paper.analysis.methodZh}</p>
            </section>
            <section>
              <h3>Experiments</h3>
              <p>{paper.analysis.experimentsZh}</p>
            </section>
            <section>
              <h3>Transferable insight</h3>
              <p>{paper.analysis.insightZh}</p>
            </section>
          </div>
          <p className={styles.sourceNote}>
            <strong>解读来源</strong> {paper.analysis.sourceNote}
          </p>
        </div>
      </article>
    </dialog>
  );
}

export function PaperReadingApp({ data }: { data: PaperReadingDataset }) {
  const [selectedDigestIndex, setSelectedDigestIndex] = useState(0);
  const [digestBundles, setDigestBundles] = useState<Record<string, PaperReadingDigestBundle>>(
    () => ({ [data.initial.digest.date]: data.initial }),
  );
  const [digestLoading, setDigestLoading] = useState(false);
  const [digestLoadError, setDigestLoadError] = useState("");
  const [storageError, setStorageError] = useState(false);
  const [selectedTopic, setSelectedTopic] = useState("all");
  const [query, setQuery] = useState("");
  const [openPaperId, setOpenPaperId] = useState<string | null>(null);
  const [readingListOpen, setReadingListOpen] = useState(false);
  const [readingListTab, setReadingListTab] = useState<ReadingListTab>("all");
  const [libraryIndex, setLibraryIndex] = useState<PaperLibraryEntry[] | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [libraryPaperCache, setLibraryPaperCache] = useState<Record<string, PaperRecord>>({});
  const digestRequestRef = useRef<AbortController | null>(null);
  const selectDigestRef = useRef<
    (index: number, historyMode?: DigestHistoryMode) => Promise<void>
  >(async () => undefined);
  const serializedPaperStates = useSyncExternalStore(
    subscribeToPaperState,
    getPaperStateSnapshot,
    getServerPaperStateSnapshot,
  );
  const paperStates = useMemo(
    () => parsePaperStates(serializedPaperStates),
    [serializedPaperStates],
  );

  const selectedDigestEntry = data.digestIndex[selectedDigestIndex] || data.digestIndex[0];
  const activeBundle = digestBundles[selectedDigestEntry.date] || data.initial;
  const digest = activeBundle.digest;
  const digestPapers = activeBundle.papers;
  const topicCounts = useMemo(() => {
    const counts = new Map<string, number>();
    digestPapers.forEach((paper) => {
      paper.topicIds.forEach((topicId) => {
        counts.set(topicId, (counts.get(topicId) || 0) + 1);
      });
    });
    return counts;
  }, [digestPapers]);
  const dailyTopics = useMemo(
    () => data.topics.filter((topic) => (topicCounts.get(topic.id) || 0) > 0),
    [data.topics, topicCounts],
  );
  const loadedPapersById = useMemo(() => {
    const loaded: Record<string, PaperRecord> = { ...libraryPaperCache };
    Object.values(digestBundles).forEach((bundle) => {
      bundle.papers.forEach((paper) => {
        loaded[paper.id] = paper;
      });
    });
    return loaded;
  }, [digestBundles, libraryPaperCache]);
  const openPaper = openPaperId ? loadedPapersById[openPaperId] || null : null;
  const readingListCount = Object.values(paperStates).filter(
    (state) => state.starred || state.readLater,
  ).length;

  const normalizedQuery = normalizeSearch(query);
  const visiblePapers = digestPapers.filter((paper) => {
    const inTopic = selectedTopic === "all" || paper.topicIds.includes(selectedTopic);
    const inSearch = !normalizedQuery || getSearchText(paper).includes(normalizedQuery);
    return inTopic && inSearch;
  });

  const closePaper = useCallback(() => {
    setOpenPaperId(null);
    const cleanUrl = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(null, "", cleanUrl);
  }, []);

  const showPaper = useCallback((paper: PaperRecord) => {
    setOpenPaperId(paper.id);
    window.history.replaceState(null, "", `#${paper.slug}`);
  }, []);

  useEffect(() => {
    const slug = window.location.hash.slice(1);
    if (!slug) return;
    const paper = Object.values(loadedPapersById).find((candidate) => candidate.slug === slug);
    if (paper) {
      const frame = window.requestAnimationFrame(() => setOpenPaperId(paper.id));
      return () => window.cancelAnimationFrame(frame);
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return;

    const controller = new AbortController();
    void fetch(`/paper-reading/data/papers/${slug}.json`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<PaperRecord>;
      })
      .then((record) => {
        setLibraryPaperCache((current) => ({ ...current, [record.id]: record }));
        setOpenPaperId(record.id);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
      });
    return () => controller.abort();
  }, [loadedPapersById]);

  function updatePaperState(paperId: string, patch: Partial<PaperUserState>) {
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
  }

  async function openReadingList(tab: ReadingListTab = "all") {
    setReadingListTab(tab);
    setReadingListOpen(true);
    setLibraryError("");
    if (libraryIndex || libraryLoading) return;

    setLibraryLoading(true);
    try {
      const response = await fetch("/paper-reading/data/paper-index.json");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setLibraryIndex((await response.json()) as PaperLibraryEntry[]);
    } catch {
      setLibraryError("阅读列表暂时无法加载，请稍后重试。");
    } finally {
      setLibraryLoading(false);
    }
  }

  async function showLibraryPaper(entry: PaperLibraryEntry) {
    setLibraryError("");
    const cached = loadedPapersById[entry.id];
    if (cached) {
      setReadingListOpen(false);
      window.requestAnimationFrame(() => showPaper(cached));
      return;
    }

    try {
      const response = await fetch(`/paper-reading/data/papers/${entry.slug}.json`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const paper = (await response.json()) as PaperRecord;
      setLibraryPaperCache((current) => ({ ...current, [paper.id]: paper }));
      setReadingListOpen(false);
      window.requestAnimationFrame(() => showPaper(paper));
    } catch {
      setLibraryError("这篇论文的详细解读暂时无法加载。");
    }
  }

  async function selectDigest(index: number, historyMode: DigestHistoryMode = "push") {
    const entry = data.digestIndex[index];
    if (!entry) return;

    digestRequestRef.current?.abort();
    digestRequestRef.current = null;

    if (index === selectedDigestIndex) {
      setDigestLoading(false);
      if (historyMode === "push") {
        const url = new URL(window.location.href);
        url.searchParams.set("date", entry.date);
        url.hash = "";
        window.history.pushState(null, "", `${url.pathname}${url.search}`);
      }
      return;
    }

    setDigestLoadError("");
    const cached = digestBundles[entry.date];
    if (cached) {
      setDigestLoading(false);
      closePaper();
      setSelectedTopic((current) =>
        current === "all" || cached.papers.some((paper) => paper.topicIds.includes(current))
          ? current
          : "all",
      );
      setSelectedDigestIndex(index);
      if (historyMode === "push") {
        const url = new URL(window.location.href);
        url.searchParams.set("date", entry.date);
        url.hash = "";
        window.history.pushState(null, "", `${url.pathname}${url.search}`);
      }
      return;
    }

    const controller = new AbortController();
    digestRequestRef.current = controller;
    setDigestLoading(true);
    try {
      const response = await fetch(`/paper-reading/data/digests/${entry.date}.json`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bundle = (await response.json()) as PaperReadingDigestBundle;
      if (digestRequestRef.current !== controller) return;
      setDigestBundles((current) => ({ ...current, [entry.date]: bundle }));
      closePaper();
      setSelectedTopic((current) =>
        current === "all" || bundle.papers.some((paper) => paper.topicIds.includes(current))
          ? current
          : "all",
      );
      setSelectedDigestIndex(index);
      if (historyMode === "push") {
        const url = new URL(window.location.href);
        url.searchParams.set("date", entry.date);
        url.hash = "";
        window.history.pushState(null, "", `${url.pathname}${url.search}`);
      }
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setDigestLoadError("这一天的日报暂时无法加载，请稍后重试。");
    } finally {
      if (digestRequestRef.current === controller) {
        digestRequestRef.current = null;
        setDigestLoading(false);
      }
    }
  }

  useEffect(() => {
    selectDigestRef.current = selectDigest;
  });

  useEffect(
    () => () => {
      digestRequestRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    function applyDateFromUrl() {
      const url = new URL(window.location.href);
      const requestedDate = url.searchParams.get("date");
      const index = requestedDate
        ? data.digestIndex.findIndex((entry) => entry.date === requestedDate)
        : 0;

      if (requestedDate && index < 0) {
        url.searchParams.delete("date");
        url.hash = "";
        window.history.replaceState(null, "", `${url.pathname}${url.search}`);
        void selectDigestRef.current(0, "none");
        setDigestLoadError(`没有 ${requestedDate} 的日报，已显示最近一期。`);
        return;
      }

      setDigestLoadError("");
      void selectDigestRef.current(index, "none");
    }

    applyDateFromUrl();
    window.addEventListener("popstate", applyDateFromUrl);
    return () => window.removeEventListener("popstate", applyDateFromUrl);
  }, [data.digestIndex]);

  return (
    <main className={styles.paperReading} lang="zh-CN">
      <div className={styles.backgroundGlow} aria-hidden="true" />
      <div className={styles.shell}>
        <header className={styles.pageHeader}>
          <div className={styles.brandRow}>
            <Link className={styles.homeLink} href="/">
              <span aria-hidden="true">←</span> ZHENG Hanyou
            </Link>
            <p className={styles.radarMark}>Personal Research Radar</p>
          </div>
          <h1>Paper Reading</h1>
          <nav className={styles.viewSwitcher} aria-label="Paper Reading 视图">
            <Link href="/paper_reading/daily/" aria-current="page">
              Daily
            </Link>
            <Link href="/paper_reading/library/">Library</Link>
          </nav>
        </header>

        <section
          className={styles.controlDeck}
          aria-label="论文日报筛选"
          aria-busy={digestLoading}
        >
          <div className={styles.topicSwitcher} role="group" aria-label="研究方向">
            <button
              type="button"
              aria-pressed={selectedTopic === "all"}
              className={selectedTopic === "all" ? styles.topicActive : ""}
              onClick={() => setSelectedTopic("all")}
            >
              全部方向
              <span>{digestPapers.length}</span>
            </button>
            {dailyTopics.map((topic) => {
              const count = topicCounts.get(topic.id) || 0;
              return (
                <button
                  type="button"
                  data-accent={topic.accent}
                  aria-pressed={selectedTopic === topic.id}
                  className={selectedTopic === topic.id ? styles.topicActive : ""}
                  onClick={() => setSelectedTopic(topic.id)}
                  key={topic.id}
                >
                  {topic.shortLabel}
                  <span>{count}</span>
                </button>
              );
            })}
          </div>

          <div className={styles.utilityRow}>
            <div className={styles.dateControl}>
              <button
                type="button"
                disabled={digestLoading || selectedDigestIndex >= data.digestIndex.length - 1}
                onClick={() => void selectDigest(selectedDigestIndex + 1)}
                aria-label="查看更早的日报"
              >
                ‹
              </button>
              <DatePicker
                availableDates={data.digestIndex.map((entry) => entry.date)}
                currentDate={selectedDigestEntry.date}
                disabled={digestLoading}
                onChange={(date) => {
                  const index = data.digestIndex.findIndex((entry) => entry.date === date);
                  if (index >= 0) void selectDigest(index);
                }}
              />
              <button
                type="button"
                disabled={digestLoading || selectedDigestIndex === 0}
                onClick={() => void selectDigest(selectedDigestIndex - 1)}
                aria-label="查看更新的日报"
              >
                ›
              </button>
            </div>

            <label className={styles.searchBox}>
              <span className={styles.searchIcon} aria-hidden="true" />
              <span className={styles.srOnly}>搜索标题、作者或关键词</span>
              <input
                type="search"
                inputMode="search"
                placeholder="搜索标题、作者或关键词"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? (
                <button
                  className={styles.searchClear}
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="清除搜索"
                >
                  <span aria-hidden="true">×</span>
                </button>
              ) : null}
            </label>
          </div>
          {digestLoadError ? <p className={styles.loadError}>{digestLoadError}</p> : null}
          {storageError ? <p className={styles.loadError}>当前浏览器无法保存阅读状态。</p> : null}
        </section>

        <TopicBriefs
          digest={digest}
          topics={data.topics}
          topicCounts={topicCounts}
          selectedTopic={selectedTopic}
        />

        <section className={styles.feedSection} aria-labelledby="paper-feed-title">
          <div className={styles.feedHeading}>
            <h2 id="paper-feed-title">
              {selectedTopic === "all"
                ? "本期论文"
                : data.topics.find((topic) => topic.id === selectedTopic)?.labelZh}
            </h2>
            <div className={styles.feedHeadingActions}>
              <span>{visiblePapers.length} 篇</span>
              <button type="button" onClick={() => void openReadingList()}>
                <span aria-hidden="true">★</span>
                阅读列表
                <strong>{readingListCount}</strong>
              </button>
            </div>
          </div>

          {visiblePapers.length ? (
            <div className={styles.paperList}>
              {visiblePapers.map((paper) => (
                <PaperScanCard
                  paper={paper}
                  topics={data.topics}
                  userState={paperStates[paper.id] || {}}
                  updateUserState={(patch) => updatePaperState(paper.id, patch)}
                  onOpen={() => showPaper(paper)}
                  key={paper.id}
                />
              ))}
            </div>
          ) : (
            <div className={styles.emptyState}>
              <strong>没有匹配的论文</strong>
              <p>可以清除搜索，或切换到其他研究方向。</p>
            </div>
          )}
        </section>

        <aside className={styles.dailyNotes} aria-labelledby="daily-notes-title">
          <div className={styles.dailyNotesHeading}>
            <span>Notes</span>
            <h2 id="daily-notes-title">本期备注</h2>
          </div>
          <div className={styles.notesList}>
            {digest.sourceStatus.map((source) => (
              <div className={styles.noteItem} data-status={source.status} key={source.label}>
                <span aria-hidden="true" />
                <div>
                  <strong>{source.label}</strong>
                  <p>{source.noteZh}</p>
                </div>
              </div>
            ))}
          </div>
        </aside>

        <footer className={styles.footer}>
          <p>Paper Reading · Zheng Hanyou</p>
          <Link href="/">返回主页</Link>
        </footer>
      </div>

      <ReadingListDrawer
        open={readingListOpen}
        activeTab={readingListTab}
        entries={libraryIndex}
        loading={libraryLoading}
        error={libraryError}
        topics={data.topics}
        paperStates={paperStates}
        onTabChange={setReadingListTab}
        onClose={() => setReadingListOpen(false)}
        onOpenPaper={(entry) => void showLibraryPaper(entry)}
        updateUserState={updatePaperState}
      />

      <PaperDetailDialog
        paper={openPaper}
        topics={data.topics}
        userState={openPaper ? paperStates[openPaper.id] || {} : {}}
        updateUserState={(patch) => {
          if (openPaper) updatePaperState(openPaper.id, patch);
        }}
        onClose={closePaper}
      />
    </main>
  );
}
