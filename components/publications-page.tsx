import Link from "next/link";
import { PublicationEntry } from "@/components/publication-entry";
import { SiteHeader } from "@/components/site-header";
import { publications, type Language } from "@/content/site";

export function PublicationsPage({ language }: { language: Language }) {
  const years = [...new Set(publications.map((publication) => publication.year))].sort(
    (a, b) => b - a,
  );

  return (
    <>
      <SiteHeader language={language} page="publications" />
      <main className="page-shell subpage">
        <div className="subpage-heading">
          <h1>{language === "en" ? "Publications" : "学术论文"}</h1>
        </div>
        <div className="publication-years">
          {years.map((year) => (
            <section className="publication-year-group" key={year} aria-labelledby={`year-${year}`}>
              <h2 id={`year-${year}`}>{year}</h2>
              <div className="publication-list">
                {publications
                  .filter((publication) => publication.year === year)
                  .map((publication) => (
                    <PublicationEntry
                      key={publication.slug}
                      publication={publication}
                      language={language}
                      showYear={false}
                    />
                  ))}
              </div>
            </section>
          ))}
        </div>
        <Link className="back-link" href={language === "en" ? "/" : "/zh"}>
          {language === "en" ? "← Back to home" : "← 返回首页"}
        </Link>
      </main>
    </>
  );
}
