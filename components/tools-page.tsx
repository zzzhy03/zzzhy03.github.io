import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import type { Language } from "@/content/site";
import { tools } from "@/content/tools";

const copy = {
  en: {
    title: "Open-source Tools",
    introduction: "Small tools and reusable workflows I build and share through my research practice.",
    github: "GitHub",
    documentation: "Documentation",
    download: "Download",
    license: "MIT License",
    back: "← Back to home",
  },
  zh: {
    title: "开源工具",
    introduction: "从科研实践中积累、开发并分享的小工具与可复用工作流。",
    github: "GitHub",
    documentation: "使用文档",
    download: "下载",
    license: "MIT 许可证",
    back: "← 返回首页",
  },
} as const;

export function ToolsPage({ language }: { language: Language }) {
  const t = copy[language];

  return (
    <>
      <SiteHeader language={language} page="tools" />
      <main className="page-shell subpage" lang={language}>
        <div className="subpage-heading tools-heading">
          <h1>{t.title}</h1>
          <p>{t.introduction}</p>
        </div>

        <div className="tool-list">
          {tools.map((tool) => (
            <article className="tool-card" id={tool.slug} key={tool.slug} aria-labelledby={`${tool.slug}-name`}>
              <h2 id={`${tool.slug}-name`}>{tool.name}</h2>
              <ul className="tool-tags" aria-label={language === "en" ? "Topics" : "主题"}>
                {tool.tags.map((tag) => <li key={tag.en}>{tag[language]}</li>)}
              </ul>
              <p className="tool-card-description">{tool.description[language]}</p>
              <ul className="tool-card-skills">
                {tool.skills.map((skill) => (
                  <li key={skill.slug}>
                    <h3>
                      <a href={skill.href} target="_blank" rel="noreferrer">{skill.title[language]}</a>
                    </h3>
                    <p>{skill.description[language]}</p>
                  </li>
                ))}
              </ul>
              <div className="tool-links" aria-label={language === "en" ? `Links for ${tool.name}` : `${tool.name} 相关链接`}>
                <a href={tool.repository} target="_blank" rel="noreferrer">{t.github}</a>
                <a href={tool.documentation[language]} target="_blank" rel="noreferrer">{t.documentation}</a>
                <a href={tool.releases} target="_blank" rel="noreferrer">{t.download}</a>
                <a href={tool.license} target="_blank" rel="noreferrer">{t.license}</a>
              </div>
            </article>
          ))}
        </div>

        <Link className="back-link" href={language === "en" ? "/" : "/zh"}>{t.back}</Link>
      </main>
    </>
  );
}
