import type { Metadata } from "next";
import { PublicationsPage } from "@/components/publications-page";

export const metadata: Metadata = {
  title: "学术论文 · 郑寒友",
  description: "郑寒友的学术论文。",
};

export default function ChinesePublications() {
  return <PublicationsPage language="zh" />;
}
