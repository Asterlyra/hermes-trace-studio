import type { Metadata } from "next";
import "@xyflow/react/dist/style.css";
import "./globals.css";
import "./icewater-theme.css";
import "./readable-layout.css";
import "./analysis-views.css";
import "./shell-layout.css";

export const metadata: Metadata = {
  title: "Hermes Trace Studio",
  description: "记录并解释 Hermes Agent 在一次请求中的完整可观测工作流。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
