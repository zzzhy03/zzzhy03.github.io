import Image from "next/image";
import type { Language, Publication } from "@/content/site";

function Authors({ publication }: { publication: Publication }) {
  return (
    <p className="publication-authors">
      {publication.authors.map((author, index) => (
        <span key={`${publication.slug}-${author.name}-${index}`}>
          {author.name === "Hanyou Zheng" ? <strong>{author.name}</strong> : author.name}
          {author.mark ? <sup>{author.mark}</sup> : null}
          {index < publication.authors.length - 1 ? ", " : ""}
        </span>
      ))}
    </p>
  );
}

export function PublicationEntry({
  publication,
  language,
  showYear = true,
}: {
  publication: Publication;
  language: Language;
  showYear?: boolean;
}) {
  return (
    <article className={`publication-entry${publication.image ? " with-image" : ""}`}>
      {publication.image ? (
        <div className="publication-image-wrap">
          <Image
            src={publication.image}
            alt={publication.imageAlt?.[language] ?? ""}
            fill
            sizes="(max-width: 720px) calc(100vw - 32px), 330px"
          />
        </div>
      ) : null}
      <div className="publication-content">
        {showYear ? <p className="publication-year">{publication.year}</p> : null}
        <h3>{publication.title}</h3>
        <Authors publication={publication} />
        <p className="publication-venue">{publication.venue}</p>
        <p className="publication-description">{publication.description[language]}</p>
        <div className="publication-links" aria-label={`Links for ${publication.title}`}>
          {publication.links.map((link) => (
            <a key={link.label} href={link.href} target="_blank" rel="noreferrer">
              {link.label}
            </a>
          ))}
        </div>
        {publication.note ? (
          <p className="publication-note">{publication.note[language]}</p>
        ) : null}
      </div>
    </article>
  );
}
