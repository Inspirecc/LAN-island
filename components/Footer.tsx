// components/Footer.tsx — 页脚(服务端组件)
import Link from "next/link";
import { Github, Mail } from "lucide-react";
import { siteConfig } from "@/siteConfig";
import { daysSince } from "@/lib/posts";

export default function Footer() {
  const socials = [
    siteConfig.social.github && {
      icon: Github,
      href: siteConfig.social.github,
      label: "GitHub",
    },
    siteConfig.social.email && {
      icon: Mail,
      href: `mailto:${siteConfig.social.email}`,
      label: "Email",
    },
  ].filter(Boolean) as { icon: typeof Github; href: string; label: string }[];

  return (
    <footer className="relative z-10 mt-20 border-t border-white/20 bg-white/30 py-10 backdrop-blur-xl dark:border-white/5 dark:bg-slate-900/40">
      <div className="mx-auto flex w-[92%] max-w-6xl flex-col items-center gap-4 text-center">
        <p className="text-lg font-black">
          <span className="text-aurora">{siteConfig.title}</span>
        </p>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {siteConfig.subtitle} · 已漂流 {daysSince(siteConfig.buildDate)} 天
        </p>
        <div className="flex items-center gap-4">
          {socials.map(({ icon: Icon, href, label }) => (
            <a
              key={label}
              href={href}
              target="_blank"
              rel="noreferrer"
              aria-label={label}
              className="text-slate-500 transition-colors hover:text-indigo-500 dark:text-slate-400"
            >
              <Icon size={18} />
            </a>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-slate-400 dark:text-slate-500">
          {siteConfig.footerBadges.map((b) => (
            <span
              key={b}
              className="rounded-full border border-white/30 bg-white/40 px-2.5 py-0.5 dark:border-white/10 dark:bg-white/5"
            >
              {b}
            </span>
          ))}
        </div>
        <p className="text-xs text-slate-400 dark:text-slate-500">
          © {new Date().getFullYear()} {siteConfig.author} · {siteConfig.title}
          {siteConfig.icp && (
            <>
              {" · "}
              <span>{siteConfig.icp}</span>
            </>
          )}
        </p>
        <Link
          href="/"
          className="text-xs text-slate-400 transition-colors hover:text-indigo-500 dark:text-slate-500"
        >
          回到岛顶 ↑
        </Link>
      </div>
    </footer>
  );
}
