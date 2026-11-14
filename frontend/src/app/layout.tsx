import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Suspense } from "react";
import { Nav } from "@/components/Nav";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono-jb" });

export const metadata: Metadata = {
  title: "Sky Time Machine",
  description: "Explore the universe. Travel through observations. Discover what changed.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="min-h-dvh flex flex-col">
        <Suspense fallback={<div className="h-12 border-b border-line" />}>
          <Nav />
        </Suspense>
        <main className="flex-1 flex flex-col min-h-0">{children}</main>
      </body>
    </html>
  );
}
