import type { Metadata } from "next";
import { HomePage } from "@/components/home-page";

export const metadata: Metadata = {
  title: "郑寒友",
  description: "郑寒友的学术个人主页。",
};

export default function ChineseHome() {
  return <HomePage language="zh" />;
}
