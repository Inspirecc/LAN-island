// lib/posts.ts — Markdown 读取与解析(仅服务端使用,含 Node API)
import fs from "fs";
import path from "path";
import matter from "gray-matter";
import type { Post, PostMeta } from "./types";

export type { Post, PostMeta };

const POSTS_DIR = path.join(process.cwd(), "posts");
const MOMENTS_DIR = path.join(process.cwd(), "moments");

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 读取一个目录下所有 .md,解析 front-matter,按日期倒序 */
function loadDir(dir: string, defaultCategory: string): Post[] {
  ensureDir(dir);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  const posts = files.map((fileName) => {
    const fullPath = path.join(dir, fileName);
    const raw = fs.readFileSync(fullPath, "utf8");
    const { data, content } = matter(raw);
    const slug = fileName.replace(/\.md$/, "");
    const wordCount = content.replace(/\s/g, "").length;
    return {
      slug,
      title: data.title || slug,
      date: data.date ? new Date(data.date).toISOString() : new Date().toISOString(),
      description: data.description || content.trim().slice(0, 80) + "…",
      cover: data.cover || "",
      tags: Array.isArray(data.tags) ? data.tags : [],
      category: data.category || defaultCategory,
      top: Boolean(data.top),
      wordCount,
      readingMinutes: Math.max(1, Math.round(wordCount / 400)),
      content,
    } satisfies Post;
  });
  return posts.sort((a, b) => {
    if (a.top !== b.top) return a.top ? -1 : 1; // 置顶优先
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });
}

/** 全部文章(置顶优先,其余按日期倒序) */
export function getAllPosts(): Post[] {
  return loadDir(POSTS_DIR, "随笔");
}

/** 全部说说 */
export function getAllMoments(): Post[] {
  return loadDir(MOMENTS_DIR, "说说");
}

/** 按 slug 找单篇 */
export function getPostBySlug(slug: string): Post | undefined {
  return getAllPosts().find((p) => p.slug === slug);
}

/** 所有分类及计数(按文章数倒序) */
export function getCategories(): { name: string; count: number }[] {
  const map = new Map<string, number>();
  for (const p of getAllPosts()) map.set(p.category, (map.get(p.category) || 0) + 1);
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/** 所有标签及计数(按出现次数倒序) */
export function getTagMap(): { name: string; count: number }[] {
  const map = new Map<string, number>();
  for (const p of getAllPosts()) for (const t of p.tags) map.set(t, (map.get(t) || 0) + 1);
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/** 归档:按年分组 */
export function getArchive(): { year: string; posts: PostMeta[] }[] {
  const map = new Map<string, Post[]>();
  for (const p of getAllPosts()) {
    const y = new Date(p.date).getFullYear().toString();
    if (!map.has(y)) map.set(y, []);
    map.get(y)!.push(p);
  }
  return [...map.entries()]
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([year, posts]) => [year, posts] as const)
    .map(([year, posts]) => ({ year, posts: posts.map(({ content: _c, ...m }) => m) }));
}

/** Markdown → HTML(构建期渲染;GFM 表格/删除线 + 代码高亮) */
export async function markdownToHtml(md: string): Promise<string> {
  const { unified } = await import("unified");
  const remarkParse = (await import("remark-parse")).default;
  const remarkGfm = (await import("remark-gfm")).default;
  const remarkRehype = (await import("remark-rehype")).default;
  const rehypeHighlight = (await import("rehype-highlight")).default;
  const rehypeStringify = (await import("rehype-stringify")).default;

  const result = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeHighlight as never, { detect: true, ignoreMissing: true })
    .use(rehypeStringify, { allowDangerousHtml: true })
    .process(md);
  return String(result);
}

import { daysSince } from "./format";

/** 日期格式化:2025-01-01(转发到纯函数模块,保持旧导入路径可用) */
export { formatDate, daysSince } from "./format";
