import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "LiveProbe Documentation",
    template: "%s | LiveProbe",
  },
  description:
    "Install LiveProbe runtime agents, connect MCP tools, and operate bounded production probes.",
  metadataBase: new URL("https://docs.liveprobe.tryastrea.tech"),
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
