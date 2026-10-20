"use client";

import Link from "next/link";
import { useState } from "react";
import type { ModelUpdatesDataset } from "./types";
import base from "@/features/paper-reading/paper-reading.module.css";
import styles from "./model-updates.module.css";

const labels = { "model-release": "模型发布", "technical-report": "技术报告", "capability-update": "能力更新", "weights-release": "权重开放" };

export function ModelUpdatesApp({ data }: { data: ModelUpdatesDataset }) {
  const [publisherId, setPublisherId] = useState("all");
  const [query, setQuery] = useState("");
  const publishers = new Map(data.publishers.map((publisher) => [publisher.id, publisher]));
  const search = query.trim().toLocaleLowerCase();
  const events = data.events.filter((event) => (publisherId === "all" || event.publisherId === publisherId) &&
    (!search || `${event.title} ${event.model} ${event.summaryZh} ${publishers.get(event.publisherId)?.name}`.toLocaleLowerCase().includes(search)));
  const checkedAt = data.checks.checkedAt ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Hong_Kong", month: "long", day: "numeric" }).format(new Date(data.checks.checkedAt)) : null;

  return (
    <main className={base.paperReading} lang="zh-CN">
      <div className={base.backgroundGlow} aria-hidden="true" />
      <div className={base.shell}>
        <header className={base.pageHeader}>
          <div className={base.brandRow}>
            <Link className={base.homeLink} href="/"><span aria-hidden="true">←</span> ZHENG Hanyou</Link>
            <p className={base.radarMark}>Personal Research Radar</p>
          </div>
          <h1>Model Updates</h1>
          <nav className={base.viewSwitcher} aria-label="Paper Reading 视图">
            <Link href="/paper_reading/daily/">Daily</Link>
            <Link href="/paper_reading/library/">Library</Link>
            <Link href="/paper_reading/updates/" aria-current="page">Model Updates</Link>
          </nav>
        </header>

        <section className={styles.intro} aria-labelledby="updates-title">
          <div><span className={styles.eyebrow}>Official releases</span><h2 id="updates-title">重点团队与模型动态</h2><p>跟进官方模型发布、技术报告、重要能力更新与权重开放。</p></div>
          <p className={styles.checked}>{checkedAt ? `${checkedAt} 已核对来源` : "等待首次来源检查"}</p>
        </section>

        <section className={styles.controls} aria-label="模型动态筛选">
          <div className={styles.filters} role="group" aria-label="发布团队">
            <button type="button" aria-pressed={publisherId === "all"} onClick={() => setPublisherId("all")}>全部团队</button>
            {data.publishers.map((publisher) => <button key={publisher.id} type="button" aria-pressed={publisherId === publisher.id} onClick={() => setPublisherId(publisher.id)}>{publisher.name}</button>)}
          </div>
          <label className={styles.search}><span className={base.srOnly}>搜索模型或动态</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型或动态" /></label>
        </section>

        <div className={styles.layout}>
          <section className={styles.feed} aria-label="官方发布动态" aria-live="polite">
            {events.length === 0 ? <div className={styles.empty}><h3>{query ? "没有匹配的动态" : "暂时没有收录的动态"}</h3><p>{query ? "试试其他模型名称或团队。" : "这个团队的已核实新发布会出现在这里。"}</p><button type="button" onClick={() => { setPublisherId("all"); setQuery(""); }}>查看全部动态</button></div> : events.map((event) => (
              <article className={styles.card} key={event.id}>
                <div className={styles.meta}><span>{publishers.get(event.publisherId)?.name}</span><span className={styles.badge}>{labels[event.eventType]}</span><time dateTime={event.publishedAt}>{event.publishedAt}</time></div>
                <h3><a href={event.sourceUrl} target="_blank" rel="noreferrer">{event.title}<span aria-hidden="true"> ↗</span></a></h3>
                <p className={styles.summary}>{event.summaryZh}</p>
                <ul className={styles.changes}>{event.changesZh.map((change) => <li key={change}>{change}</li>)}</ul>
                <p className={styles.availability}><strong>开放情况</strong>{event.availabilityZh}</p>
                <p className={styles.evidence}>{event.evidenceNoteZh}</p>
                <div className={styles.links}>{event.links.map((link) => <a key={link.href} href={link.href} target="_blank" rel="noreferrer">{link.label} <span aria-hidden="true">↗</span></a>)}</div>
              </article>
            ))}
          </section>
          <aside className={styles.following} aria-label="关注中的团队">
            <span className={styles.eyebrow}>Following</span><h2>关注中的团队</h2>
            {data.publishers.map((publisher) => {
              const check = data.checks.sources.find((source) => source.publisherId === publisher.id);
              const status = check?.status === "checked" ? "官方来源已检查" : check?.status === "partial" ? "来源覆盖待补充" : check?.status === "failed" ? "暂时无法检查" : "等待检查";
              return <div className={styles.publisher} key={publisher.id}><a href={publisher.homeUrl} target="_blank" rel="noreferrer">{publisher.name} ↗</a><span data-status={check?.status}>{status}</span></div>;
            })}
            <p className={styles.asideNote}>按团队与模型持续积累，不受论文研究方向限制。发布日期保留官方原始日期。</p>
          </aside>
        </div>
      </div>
    </main>
  );
}
