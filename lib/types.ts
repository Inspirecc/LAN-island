// lib/types.ts — 纯类型定义(客户端/服务端都可安全导入,零 Node 依赖)

export interface PostMeta {
  slug: string;
  title: string;
  date: string;
  description: string;
  cover: string;
  tags: string[];
  category: string;
  top: boolean;
  readingMinutes: number;
  wordCount: number;
}

export interface Post extends PostMeta {
  content: string; // 原始 Markdown(不含 front-matter)
}
