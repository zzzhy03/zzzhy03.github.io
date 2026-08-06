import { permanentRedirect } from "next/navigation";

export default function PaperReadingIndexPage() {
  permanentRedirect("/paper_reading/daily/");
}
