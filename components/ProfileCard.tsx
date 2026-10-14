// components/ProfileCard.tsx — 首页个人名片(服务端组件 + 客户端头像)
import { Github, Mail, MapPin } from "lucide-react";
import { siteConfig } from "@/siteConfig";

export default function ProfileCard({
  postCount,
  momentCount,
}: {
  postCount: number;
  momentCount: number;
}) {
  const socials = [
    siteConfig.social.github && { icon: Github, href: siteConfig.social.github },
    siteConfig.social.email && { icon: Mail, href: `mailto:${siteConfig.social.email}` },
  ].filter(Boolean) as { icon: typeof Github; href: string }[];

  return (
    <section className="glass relative overflow-hidden rounded-3xl p-6 sm:p-8">
      <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-gradient-to-br from-indigo-400/20 to-pink-400/20 blur-2xl" />
      <div className="flex items-center gap-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={siteConfig.avatarUrl}
          alt={siteConfig.author}
          className="h-20 w-20 rounded-2xl border border-white/40 shadow-lg dark:border-white/10"
        />
        <div>
          <h1 className="text-2xl font-black">
            你好,我是 <span className="text-aurora">{siteConfig.author}</span>
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {siteConfig.bio}
          </p>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-3 gap-3 text-center">
        {[
          { label: "文章", value: postCount },
          { label: "说说", value: momentCount },
          { label: "标签云", value: "→" },
        ].map((s) => (
          <div
            key={s.label}
            className="rounded-2xl border border-white/30 bg-white/40 py-3 dark:border-white/5 dark:bg-white/5"
          >
            <p className="text-xl font-black text-aurora">{s.value}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">{s.label}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 flex items-center justify-between">
        <p className="flex items-center gap-1 text-xs text-slate-400 dark:text-slate-500">
          <MapPin size={13} /> {siteConfig.subtitle}
        </p>
        <div className="flex items-center gap-3">
          {socials.map(({ icon: Icon, href }, i) => (
            <a
              key={i}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-slate-500 transition-all hover:-translate-y-0.5 hover:text-indigo-500 dark:text-slate-400"
            >
              <Icon size={18} />
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
