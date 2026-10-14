// app/page.tsx — 首页:Bento 布局
import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import { getAllMoments, getAllPosts, getTagMap } from "@/lib/posts";
import { siteConfig } from "@/siteConfig";
import ProfileCard from "@/components/ProfileCard";
import SiteStats from "@/components/SiteStats";
import LatestPosts from "@/components/LatestPosts";
import PostCard from "@/components/PostCard";

export default function Home() {
  const posts = getAllPosts();
  const moments = getAllMoments();
  const tags = getTagMap().slice(0, 12);
  const latest = posts.slice(0, 6);

  return (
    <div className="flex flex-col gap-6 pb-10">
      {/* 第一行:名片 + 统计 */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <ProfileCard postCount={posts.length} momentCount={moments.length} />
        </div>
        <div className="flex flex-col gap-6 lg:col-span-5">
          <SiteStats
            postCount={posts.length}
            momentCount={moments.length}
            tagCount={getTagMap().length}
          />
          <Link
            href="/about"
            className="glass group flex items-center justify-between rounded-2xl p-5 transition-all duration-500 hover:-translate-y-1"
          >
            <span className="flex items-center gap-2 text-sm font-bold">
              <Sparkles size={16} className="text-amber-400" />
              关于这座小岛
            </span>
            <ArrowRight
              size={16}
              className="text-slate-400 transition-transform group-hover:translate-x-1 group-hover:text-indigo-500"
            />
          </Link>
        </div>
      </div>

      {/* 第二行:最新文章轮播 */}
      <LatestPosts posts={latest} />

      {/* 第三行:文章网格 + 标签云侧栏 */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-black">最新文章</h2>
            <Link
              href="/posts"
              className="flex items-center gap-1 text-sm font-bold text-slate-500 transition-colors hover:text-indigo-500 dark:text-slate-400"
            >
              全部文章 <ArrowRight size={14} />
            </Link>
          </div>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            {latest.slice(0, 4).map((p) => (
              <PostCard key={p.slug} post={p} />
            ))}
          </div>
        </div>

        <aside className="flex flex-col gap-6 lg:col-span-4">
          <section className="glass rounded-3xl p-6">
            <h3 className="mb-4 text-base font-black">🏷️ 标签云</h3>
            <div className="flex flex-wrap gap-2">
              {tags.map(({ name, count }) => (
                <Link
                  key={name}
                  href={`/tags#${name}`}
                  className="rounded-full border border-white/30 bg-white/40 px-3 py-1 text-xs font-bold text-slate-600 transition-all hover:-translate-y-0.5 hover:border-indigo-400 hover:text-indigo-500 dark:border-white/10 dark:bg-white/5 dark:text-slate-300"
                >
                  {name}
                  <span className="ml-1 text-slate-400">{count}</span>
                </Link>
              ))}
            </div>
          </section>

          <section className="glass rounded-3xl p-6">
            <h3 className="mb-3 text-base font-black">💬 最新说说</h3>
            {moments.length > 0 ? (
              <ul className="flex flex-col gap-3">
                {moments.slice(0, 3).map((m) => (
                  <li key={m.slug} className="border-b border-white/20 pb-3 last:border-none last:pb-0 dark:border-white/5">
                    <Link href="/moments" className="group">
                      <p className="line-clamp-2 text-sm text-slate-600 transition-colors group-hover:text-indigo-500 dark:text-slate-300">
                        {m.description}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-400">还没有说说</p>
            )}
          </section>
        </aside>
      </div>

      {/* 页面标题里的站点名 SEO 补充 */}
      <p className="sr-only">{siteConfig.title} - {siteConfig.description}</p>
    </div>
  );
}
