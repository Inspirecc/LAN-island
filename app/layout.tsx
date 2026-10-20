// app/layout.tsx — 全局布局:主题 + 极光背景 + 导航 + 页脚
import type { Metadata } from "next";
import { ThemeProvider } from "next-themes";
import { siteConfig } from "@/siteConfig";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import AuroraBackground from "@/components/AuroraBackground";
import EffectLayer from "@/components/EffectLayer";
import PageTransition from "@/components/PageTransition";
import SearchTrigger from "@/components/SearchTrigger";
import MusicPlayer from "@/components/MusicPlayer";
import { getAllPosts } from "@/lib/posts";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: `${siteConfig.title} · ${siteConfig.subtitle}`,
    template: `%s · ${siteConfig.title}`,
  },
  description: siteConfig.description,
  metadataBase: new URL(siteConfig.siteUrl),
  openGraph: {
    title: siteConfig.title,
    description: siteConfig.description,
    siteName: siteConfig.title,
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="relative">
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
          {siteConfig.effects.auroraBackground && <AuroraBackground />}
          <EffectLayer />
          <div className="relative z-10 flex min-h-screen flex-col">
            <Navbar />
            <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-24 sm:px-6">
              <PageTransition>{children}</PageTransition>
            </main>
            <Footer />
            <SearchTrigger
              items={getAllPosts().map((p) => ({
                title: p.title,
                slug: p.slug,
                category: p.category,
                description: p.description,
              }))}
            />
            <MusicPlayer />
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
