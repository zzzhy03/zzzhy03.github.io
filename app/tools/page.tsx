import type { Metadata } from "next";
import { ToolsPage } from "@/components/tools-page";

export const metadata: Metadata = {
  title: "Open-source Tools · ZHENG Hanyou",
  description: "Open-source tools by ZHENG Hanyou, including Academic Workflow: reusable AI agent skills for academic writing and figure design.",
  alternates: {
    canonical: "/tools/",
    languages: { en: "/tools/", "zh-CN": "/zh/tools/" },
  },
};

export default function EnglishTools() {
  return <ToolsPage language="en" />;
}
