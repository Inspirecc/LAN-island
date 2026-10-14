// app/tags/[tag]/page.tsx — 单个标签下的文章(服务端组件)
import Link from "next/link";
import { notFound } from "next/navigation";
import { Tag } from "lucide-react";
import { getAllPosts, getTagMap } from "@/lib/posts";
import PostCard from "@/components/PostCard";

export function generateStaticParams() {
  return getTagMap().map(({ name }) => ({ tag: encodeURIComponent(name) }));
}

export default async function TagPage({
  params,
}: {
  params: Promise<{ tag: string }>;
}) {
  const { tag } = await params;
  const name = decodeURIComponent(tag);
  const posts = getAllPosts().filter((p) => p.tags.includes(name));
  if (posts.length === 0) notFound();

  return (
    <div className="flex flex-col gap-6 pb-10">
      <header className="flex items-center gap-3">
        <span className="glass flex h-11 w-11 items-center justify-center rounded-2xl text-indigo-500">
          <Tag size={20} />
        </span>
        <div>
          <h1 className="text-2xl font-black">{name}</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {posts.length} 篇文章
          </p>
        </div>
      </header>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {posts.map((p) => (
          <PostCard key={p.slug} post={p} />
        ))}
      </div>
      <Link
        href="/tags"
        className="w-fit text-sm font-bold text-slate-500 transition-colors hover:text-indigo-500 dark:text-slate-400"
      >
        ← 全部标签
      </Link>
    </div>
  );
}
