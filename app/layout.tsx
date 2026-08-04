import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://zzzhy03.github.io"),
  title: "ZHENG Hanyou",
  description:
    "ZHENG Hanyou is a Ph.D. student at CUHK working on computer graphics, generative AI, 3D content creation, and computational design.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
