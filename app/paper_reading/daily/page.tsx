import type { Metadata } from "next";
import { PaperReadingApp } from "@/features/paper-reading/paper-reading-app";
import { loadPaperReadingData } from "@/features/paper-reading/load-data";

export const metadata: Metadata = {
  title: "Daily · Paper Reading · ZHENG Hanyou",
  description: "A daily, direction-aware paper reading feed by Hanyou Zheng.",
};

export default function PaperReadingDailyPage() {
  return <PaperReadingApp data={loadPaperReadingData()} />;
}
