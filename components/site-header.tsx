import Link from "next/link";
import type { Language } from "@/content/site";

type Page = "home" | "publications" | "tools";

const routes = {
  en: { home: "/", publications: "/publications", tools: "/tools" },
  zh: { home: "/zh", publications: "/zh/publications", tools: "/zh/tools" },
} as const;

export function SiteHeader({ language, page }: { language: Language; page: Page }) {
  const labels =
    language === "en"
      ? { home: "Home", publications: "Publications", tools: "Tools", cv: "CV" }
      : { home: "首页", publications: "论文", tools: "工具", cv: "简历" };

  return (
    <header className="site-header">
      <div className="page-shell header-inner">
        <Link className="site-name" href={routes[language].home}>
          ZHENG Hanyou <span>(郑寒友)</span>
        </Link>
        <div className="header-actions">
          <nav aria-label={language === "en" ? "Primary navigation" : "主导航"}>
            <Link className="nav-home" href={routes[language].home} aria-current={page === "home" ? "page" : undefined}>{labels.home}</Link>
            <Link href={routes[language].publications} aria-current={page === "publications" ? "page" : undefined}>{labels.publications}</Link>
            <Link href={routes[language].tools} aria-current={page === "tools" ? "page" : undefined}>{labels.tools}</Link>
            <a
              className="nav-cv"
              href={
                language === "en"
                  ? "/cv/hanyou-zheng-cv.pdf"
                  : "/cv/hanyou-zheng-cv-zh.pdf"
              }
            >
              {labels.cv}
            </a>
            <a className="nav-github" href="https://github.com/zzzhy03" target="_blank" rel="noreferrer">
              GitHub
            </a>
          </nav>
          <Link
            className="language-switch"
            href={language === "en" ? routes.zh[page] : routes.en[page]}
            aria-label={language === "en" ? "Switch to Chinese" : "切换到英文"}
          >
            <span className={language === "en" ? "active" : undefined}>EN</span>
            <span className={language === "zh" ? "active" : undefined}>中</span>
          </Link>
        </div>
      </div>
    </header>
  );
}
