import type { Metadata } from "next";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ModelUpdatesApp } from "@/features/model-updates/model-updates-app";
import type { ModelUpdatesDataset } from "@/features/model-updates/types";

export const metadata: Metadata = {
  title: "Model Updates · ZHENG Hanyou",
  description: "Official model releases and technical reports from followed teams.",
};

export default function ModelUpdatesPage() {
  const data = JSON.parse(readFileSync(path.join(process.cwd(), "public/model-updates/index.json"), "utf8")) as ModelUpdatesDataset;
  return <ModelUpdatesApp data={data} />;
}
