// components/PostCard.tsx — 文章卡片(服务端组件)
import Link from "next/link";
import { Calendar, Clock, Tag } from "lucide-react";
import type { PostMeta } from "@/lib/types";
import { formatDate } from "@/lib/posts";

export default function PostCard({ post }: { post: PostMeta }) {
  return (
    <Link
      href={`/posts/${post.slug}`}
      className="glass group flex flex-col overflow-hidden rounded-2xl transition-all duration-500 hover:-translate-y-1.5 hover:shadow-2xl"
    >
      <div className="relative h-40 overflow-hidden bg-gradient-to-br from-indigo-200/60 via-purple-200/60 to-pink-200/60 dark:from-indigo-900/40 dark:via-purple-900/40 dark:to-pink-900/40">
        {post.cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={post.cover}
            alt={post.title}
            className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-4xl opacity-40 transition-transform duration-700 group-hover:scale-110">
            🏝️
          </div>
        )}
        {post.top && (
          <span className="absolute left-3 top-3 rounded-full bg-rose-500/90 px-2.5 py-0.5 text-xs font-bold text-white shadow">
            置顶
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-5">
        <span className="w-fit rounded-full bg-indigo-500/10 px-2.5 py-0.5 text-xs font-bold text-indigo-500 dark:text-indigo-400">
          {post.category}
        </span>
        <h3 className="line-clamp-2 text-base font-black leading-snug transition-colors group-hover:text-indigo-500">
          {post.title}
        </h3>
        <p className="line-clamp-2 text-sm text-slate-500 dark:text-slate-400">
          {post.description}
        </p>
        <div className="mt-auto flex items-center gap-3 pt-2 text-xs text-slate-400 dark:text-slate-500">
          <span className="flex items-center gap-1">
            <Calendar size={12} />
            {formatDate(post.date)}
          </span>
          <span className="flex items-center gap-1">
            <Clock size={12} />
            {post.readingMinutes} 分钟
          </span>
          {post.tags.length > 0 && (
            <span className="flex items-center gap-1 truncate">
              <Tag size={12} />
              {post.tags[0]}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
