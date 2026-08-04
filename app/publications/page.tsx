import type { Metadata } from "next";
import { PublicationsPage } from "@/components/publications-page";

export const metadata: Metadata = {
  title: "Publications · ZHENG Hanyou",
  description: "Publications by ZHENG Hanyou in computer graphics and visual computing.",
};

export default function EnglishPublications() {
  return <PublicationsPage language="en" />;
}
