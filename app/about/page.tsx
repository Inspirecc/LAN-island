// app/about/page.tsx — 关于我(服务端组件;正文改这里即可)
import { BookHeart } from "lucide-react";
import { siteConfig } from "@/siteConfig";

export const metadata = { title: "关于" };

export default function AboutPage() {
  return (
    <div className="flex flex-col gap-6 pb-10">
      <header className="flex items-center gap-3">
        <BookHeart className="text-indigo-500" size={26} />
        <h1 className="text-2xl font-black">关于这座岛</h1>
      </header>

      <section className="glass rounded-3xl p-6 sm:p-10">
        <div className="flex flex-col items-start gap-6 sm:flex-row sm:items-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={siteConfig.avatarUrl}
            alt={siteConfig.author}
            className="h-28 w-28 rounded-3xl border border-white/40 shadow-lg dark:border-white/10"
          />
          <div>
            <h2 className="text-2xl font-black">
              <span className="text-aurora">{siteConfig.author}</span>
            </h2>
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              {siteConfig.bio}
            </p>
          </div>
        </div>

        <div className="prose prose-slate dark:prose-invert mt-8 max-w-none text-sm leading-7">
          <h3>关于本站</h3>
          <p>
            {siteConfig.title}(
            {siteConfig.subtitle})是我的个人博客,记录技术笔记、生活碎片与一切觉得值得留下的东西。
          </p>
          <h3>关于名字</h3>
          <p>
            LAN 是我的姓氏,ISLAND 是互联网上属于自己的一座小岛——潮水(热点)来了又去,岛一直在这里。
          </p>
          <h3>技术栈</h3>
          <p>
            Next.js 16 · React 19 · Tailwind CSS 4 · framer-motion · Vercel
            托管,零数据库,Markdown 即文章。
          </p>
        </div>
      </section>
    </div>
  );
}
