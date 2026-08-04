import Link from "next/link";
import Image from "next/image";
import { PublicationEntry } from "@/components/publication-entry";
import { SiteHeader } from "@/components/site-header";
import {
  honors,
  news,
  profileLinks,
  publications,
  teaching,
  type Language,
} from "@/content/site";

const copy = {
  en: {
    news: "News",
    selected: "Selected Publications",
    viewAll: "View all publications",
    honors: "Honors",
    teaching: "Teaching",
    teachingRole: "Teaching Assistant",
  },
  zh: {
    news: "动态",
    selected: "代表性论文",
    viewAll: "查看全部论文",
    honors: "荣誉与获奖",
    teaching: "教学经历",
    teachingRole: "助教",
  },
} as const;

function Introduction({ language }: { language: Language }) {
  if (language === "zh") {
    return (
      <div className="intro-copy">
        <p>
          我是
          <a href="https://www.cse.cuhk.edu.hk/" target="_blank" rel="noreferrer">
            香港中文大学计算机科学与工程系
          </a>
          二年级博士生，导师为
          <a href="https://www.cse.cuhk.edu.hk/~cwfu/" target="_blank" rel="noreferrer">
            Prof. Chi-Wing Fu
          </a>
          。
        </p>
        <p>
          我的研究兴趣主要位于计算机图形学与生成式人工智能的交叉领域，重点关注三维内容生成与计算设计。我也对
          AI Agent 感兴趣，尤其关注其在二维/三维理解、内容生成和计算设计中的应用，并对几何处理与渲染保持广泛兴趣。
        </p>
        <p>
          在加入香港中文大学之前，我于
          <a href="https://en.whu.edu.cn/" target="_blank" rel="noreferrer">
            武汉大学
          </a>
          获得计算机科学与技术工学学士学位。本科期间，我有幸在
          <a href="https://zhenzhong-chen.github.io/" target="_blank" rel="noreferrer">
            Prof. Zhenzhong Chen
          </a>
          指导下开展图像与视频处理相关研究，并非常感谢他一直以来的指导与帮助。科研之外，我曾参加程序设计竞赛，并获得两枚
          ICPC 亚洲区域赛金牌。
        </p>
      </div>
    );
  }

  return (
    <div className="intro-copy">
      <p>
        I am a second-year Ph.D. student in Computer Science and Engineering at{" "}
        <a href="https://www.cse.cuhk.edu.hk/" target="_blank" rel="noreferrer">
          The Chinese University of Hong Kong
        </a>
        , advised by{" "}
        <a href="https://www.cse.cuhk.edu.hk/~cwfu/" target="_blank" rel="noreferrer">
          Prof. Chi-Wing Fu
        </a>
        .
      </p>
      <p>
        My research interests lie at the intersection of computer graphics and generative
        AI, with a focus on 3D content creation and computational design. I am also
        interested in AI agents, particularly their applications to 2D/3D understanding,
        content creation, and computational design, with broader interests in geometry
        processing and rendering.
      </p>
      <p>
        Before joining CUHK, I received my B.Eng. in Computer Science and Technology from{" "}
        <a href="https://en.whu.edu.cn/" target="_blank" rel="noreferrer">
          Wuhan University
        </a>
        , where I was fortunate to work with{" "}
        <a href="https://zhenzhong-chen.github.io/" target="_blank" rel="noreferrer">
          Prof. Zhenzhong Chen
        </a>{" "}
        on image and video processing. I am deeply grateful for his guidance and support.
        Outside research, I was a competitive programmer and won two ICPC Asia Regional Gold
        Medals.
      </p>
    </div>
  );
}

export function HomePage({ language }: { language: Language }) {
  const t = copy[language];
  const selectedPublications = publications.filter((publication) => publication.selected);

  return (
    <>
      <SiteHeader language={language} page="home" />
      <main className="page-shell">
        <section className="intro" aria-labelledby="intro-name">
          <div className="intro-layout">
            <h1 id="intro-name">
              ZHENG Hanyou <span>(郑寒友)</span>
            </h1>
            <div className="intro-main">
              <Introduction language={language} />
              <div className="profile-links" aria-label="Profile links">
                {profileLinks.map((link) => (
                  <a
                    key={link.label}
                    href={link.href}
                    target={link.href.startsWith("http") ? "_blank" : undefined}
                    rel={link.href.startsWith("http") ? "noreferrer" : undefined}
                  >
                    {link.label}
                  </a>
                ))}
                <a
                  href={
                    language === "en"
                      ? "/cv/hanyou-zheng-cv.pdf"
                      : "/cv/hanyou-zheng-cv-zh.pdf"
                  }
                >
                  CV
                </a>
              </div>
            </div>
            <figure className="portrait-space">
              <Image
                src="/profile.jpg"
                alt={language === "en" ? "Portrait of Hanyou Zheng" : "郑寒友的个人照片"}
                width={950}
                height={1200}
                priority
              />
            </figure>
          </div>
        </section>

        <section className="section news-section" aria-labelledby="news-title">
          <h2 id="news-title">{t.news}</h2>
          <div className="news-list">
            {news.map((item) => (
              <div className="news-item" key={`${item.date.en}-${item.text.en}`}>
                <time>{item.date[language]}</time>
                <p>{item.text[language]}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="section" aria-labelledby="selected-publications-title">
          <div className="section-heading-row">
            <h2 id="selected-publications-title">{t.selected}</h2>
            <Link href={language === "en" ? "/publications" : "/zh/publications"}>
              {t.viewAll}
            </Link>
          </div>
          <div className="publication-list">
            {selectedPublications.map((publication) => (
              <PublicationEntry
                key={publication.slug}
                publication={publication}
                language={language}
              />
            ))}
          </div>
        </section>

        <section className="section standalone-list-section" aria-labelledby="honors-title">
          <h2 id="honors-title">{t.honors}</h2>
          <ul className="compact-list">
            {honors.map((honor) => (
              <li key={`${honor.year}-${honor.event.en}`}>
                <span>{honor.year}</span>
                <p>
                  {honor.event[language]}
                  <span className="honor-separator" aria-hidden="true"> · </span>
                  <strong>{honor.award[language]}</strong>
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section className="section standalone-list-section" aria-labelledby="teaching-title">
          <div>
            <h2 id="teaching-title">{t.teaching}</h2>
            <p className="section-note">{t.teachingRole}</p>
          </div>
          <ul className="compact-list teaching-list">
            {teaching.map((course) => (
              <li key={`${course.year}-${course.title.en}`}>
                <span>{course.term[language]}</span>
                <p>
                  {course.title[language]}
                  <small>{course.institution[language]}</small>
                </p>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer>
        <div className="page-shell footer-inner">
          <p>© 2026 ZHENG Hanyou (郑寒友)</p>
        </div>
      </footer>
    </>
  );
}
