// components/LatestPosts.tsx — 首页最新文章轮播(客户端,自动滚动)
// 布局方案:CSS Grid 叠层。所有卡片占同一个网格单元,容器高度 = 最高的卡片,
// 从根本上解决"内容比占位高就被裁切"的问题。
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, FileText } from "lucide-react";
import type { PostMeta } from "@/lib/types";
import { formatDate } from "@/lib/format";

export default function LatestPosts({ posts }: { posts: PostMeta[] }) {
  const [index, setIndex] = useState(0);
  const count = posts.length;

  useEffect(() => {
    if (count <= 1) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % count), 5000);
    return () => clearInterval(timer);
  }, [count]);

  if (count === 0) return null;

  return (
    <section className="glass relative overflow-hidden rounded-3xl p-6 sm:p-8">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-black">
          <FileText size={18} className="text-indigo-500" /> 最近更新
        </h2>
        {count > 1 && (
          <div className="flex gap-2">
            <button
              aria-label="上一篇"
              onClick={() => setIndex((index - 1 + count) % count)}
              className="rounded-full p-1.5 transition-colors hover:bg-white/40 dark:hover:bg-white/10"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              aria-label="下一篇"
              onClick={() => setIndex((index + 1) % count)}
              className="rounded-full p-1.5 transition-colors hover:bg-white/40 dark:hover:bg-white/10"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        )}
      </div>

      {/* Grid 叠层:同格堆叠,高度取所有卡片中的最大值,内容永不裁切 */}
      <div className="grid">
        {posts.map((p, i) => (
          <Link
            key={p.slug}
            href={`/posts/${p.slug}`}
            className={`flex flex-col gap-2 rounded-2xl border border-white/30 bg-white/40 p-5 transition-all duration-500 dark:border-white/5 dark:bg-white/5 ${
              i === index
                ? "z-10 translate-y-0 opacity-100"
                : "pointer-events-none invisible relative z-0 translate-y-3 opacity-0"
            }`}
          >
            <span className="text-xs font-bold text-indigo-500">{p.category}</span>
            <h3 className="line-clamp-1 text-base font-black transition-colors hover:text-indigo-500">
              {p.title}
            </h3>
            <p className="line-clamp-2 text-sm text-slate-500 dark:text-slate-400">
              {p.description}
            </p>
            <span className="text-xs text-slate-400">{formatDate(p.date)}</span>
          </Link>
        ))}
      </div>

      <div className="mt-4 flex justify-center gap-1.5">
        {posts.map((_, i) => (
          <button
            key={i}
            aria-label={`第 ${i + 1} 篇`}
            onClick={() => setIndex(i)}
            className={`h-1.5 rounded-full transition-all duration-300 ${
              i === index ? "w-5 bg-indigo-500" : "w-1.5 bg-slate-400/40"
            }`}
          />
        ))}
      </div>
    </section>
  );
}
