// app/archive/page.tsx — 归档时间轴(服务端组件)
import Link from "next/link";
import { CalendarRange } from "lucide-react";
import { formatDate, getArchive } from "@/lib/posts";

export const metadata = { title: "归档" };

export default function ArchivePage() {
  const archive = getArchive();
  const total = archive.reduce((n, y) => n + y.posts.length, 0);

  return (
    <div className="flex flex-col gap-8 pb-10">
      <header className="flex items-center gap-3">
        <CalendarRange className="text-indigo-500" size={26} />
        <div>
          <h1 className="text-2xl font-black">归档</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            共 {total} 篇 · 时光的漂流瓶
          </p>
        </div>
      </header>

      {archive.map(({ year, posts }) => (
        <section key={year} className="relative">
          <h2 className="glass mb-4 w-fit rounded-full px-5 py-1.5 text-lg font-black text-aurora">
            {year}
          </h2>
          <div className="relative ml-3 border-l-2 border-indigo-500/20 pl-8">
            {posts.map((p) => (
              <article key={p.slug} className="relative mb-5 last:mb-0">
                {/* 时间轴节点 */}
                <span className="absolute -left-[41px] top-1.5 h-3 w-3 rounded-full border-2 border-indigo-400 bg-white shadow dark:bg-slate-900" />
                <Link
                  href={`/posts/${p.slug}`}
                  className="glass group flex flex-col gap-1 rounded-2xl p-4 transition-all duration-300 hover:-translate-y-0.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <h3 className="font-bold transition-colors group-hover:text-indigo-500">
                    {p.title}
                    {p.top && (
                      <span className="ml-2 rounded-full bg-rose-500/90 px-2 py-0.5 text-[10px] font-bold text-white">
                        置顶
                      </span>
                    )}
                  </h3>
                  <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">
                    {formatDate(p.date)} · {p.category}
                  </span>
                </Link>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
