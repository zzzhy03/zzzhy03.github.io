import type { Metadata } from "next";
import { ToolsPage } from "@/components/tools-page";

export const metadata: Metadata = {
  title: "开源工具 · 郑寒友",
  description: "郑寒友开发与分享的开源工具，包括 Academic Workflow：用于论文写作和学术图稿设计的可复用 AI agent skills。",
  alternates: {
    canonical: "/zh/tools/",
    languages: { en: "/tools/", "zh-CN": "/zh/tools/" },
  },
};

export default function ChineseTools() {
  return <ToolsPage language="zh" />;
}
