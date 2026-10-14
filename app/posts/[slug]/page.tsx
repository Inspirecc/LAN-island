// app/posts/[slug]/page.tsx — 文章详情:服务端渲染 Markdown + TOC + 导航
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ArrowLeft, Calendar, Clock, FileText, Tag } from "lucide-react";
import { formatDate, getAllPosts, getPostBySlug, markdownToHtml } from "@/lib/posts";
import Comments from "@/components/Comments";
import Toc from "@/components/Toc";
import BackButton from "@/components/BackButton";

export function generateStaticParams() {
  return getAllPosts().map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getPostBySlug(slug);
  if (!post) return {};
  return {
    title: post.title,
    description: post.description,
  };
}

export default async function PostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = getPostBySlug(slug);
  if (!post) notFound();

  const html = await markdownToHtml(post.content);
  const idx = getAllPosts().findIndex((p) => p.slug === slug);
  const prev = getAllPosts()[idx + 1]; // 更早一篇
  const next = idx > 0 ? getAllPosts()[idx - 1] : undefined; // 更新一篇

  return (
    <article className="flex flex-col gap-6 pb-10">
      <BackButton />

      {/* 头部 */}
      <header className="glass rounded-3xl p-6 sm:p-10">
        <span className="rounded-full bg-indigo-500/10 px-3 py-1 text-xs font-bold text-indigo-500 dark:text-indigo-400">
          {post.category}
        </span>
        <h1 className="mt-4 text-3xl font-black leading-tight sm:text-4xl">
          {post.title}
        </h1>
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
          {post.description}
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-4 text-xs text-slate-400 dark:text-slate-500">
          <span className="flex items-center gap-1">
            <Calendar size={13} /> {formatDate(post.date)}
          </span>
          <span className="flex items-center gap-1">
            <Clock size={13} /> 约 {post.readingMinutes} 分钟
          </span>
          <span className="flex items-center gap-1">
            <FileText size={13} /> {post.wordCount} 字
          </span>
          {post.tags.map((t) => (
            <Link
              key={t}
              href={`/tags#${t}`}
              className="flex items-center gap-1 rounded-full border border-white/30 px-2.5 py-0.5 transition-colors hover:border-indigo-400 hover:text-indigo-500 dark:border-white/10"
            >
              <Tag size={11} /> {t}
            </Link>
          ))}
        </div>
      </header>

      {post.cover && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={post.cover}
          alt={post.title}
          className="glass max-h-96 w-full rounded-3xl object-cover"
        />
      )}

      {/* 正文 + TOC */}
      <div className="relative grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div
          className="glass prose prose-slate dark:prose-invert max-w-none rounded-3xl p-6 sm:p-10 lg:col-span-8"
          dangerouslySetInnerHTML={{ __html: html }}
        />
        <aside className="hidden lg:col-span-4 lg:block">
          <Toc html={html} />
        </aside>
      </div>

      {/* 上下篇 */}
      <nav className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {prev ? (
          <Link
            href={`/posts/${prev.slug}`}
            className="glass group rounded-2xl p-5 transition-all hover:-translate-y-1"
          >
            <p className="text-xs text-slate-400">← 更早一篇</p>
            <p className="mt-1 line-clamp-1 font-bold group-hover:text-indigo-500">
              {prev.title}
            </p>
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link
            href={`/posts/${next.slug}`}
            className="glass group rounded-2xl p-5 text-right transition-all hover:-translate-y-1"
          >
            <p className="text-xs text-slate-400">更新一篇 →</p>
            <p className="mt-1 line-clamp-1 font-bold group-hover:text-indigo-500">
              {next.title}
            </p>
          </Link>
        )}
      </nav>

      <Comments />
    </article>
  );
}
