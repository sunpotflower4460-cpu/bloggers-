import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Blog Garden",
  description: "Autonomous multi-blog editorial garden",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
