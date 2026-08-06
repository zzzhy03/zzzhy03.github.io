import type { Metadata } from "next";
import { PaperLibraryApp } from "@/features/paper-reading/paper-library-app";
import { loadPaperReadingData } from "@/features/paper-reading/load-data";

export const metadata: Metadata = {
  title: "All Papers · Paper Reading · ZHENG Hanyou",
  description: "The deduplicated paper library behind Hanyou Zheng's daily research feed.",
};

export default function PaperLibraryPage() {
  const data = loadPaperReadingData();

  return <PaperLibraryApp topics={data.topics} />;
}
