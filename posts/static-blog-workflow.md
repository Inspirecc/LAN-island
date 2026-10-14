---
title: Next.js 静态博客的工作流
date: 2026-01-02
description: 从写 Markdown 到全球可访问,中间只隔着一次 git push。
tags: [Next.js, Vercel]
category: 技术
---

## 构建期 vs 运行期

静态博客最重要的心智模型:**所有重活都在构建期干完**。

```ts
// 构建时:读取 posts/*.md → gray-matter 解析 → remark/rehype 渲染 → 静态 HTML
const posts = getAllPosts();
```

用户访问到的每个页面,都是构建时就生成好的 HTML + CSS + 少量水合 JS。没有数据库查询,没有服务器渲染等待。

## 部署流水线

1. `git push`
2. Vercel 监听到 push,拉代码、装依赖、跑 `next build`
3. 产出物分发到全球 CDN 边缘节点
4. 整个过程约 1~2 分钟

## 和传统全栈博客的对比

| | Aurora 式全栈 | 本站静态方案 |
|---|---|---|
| 服务器 | 需要常驻进程 | 无(纯 CDN) |
| 数据库 | MySQL + Redis | 无 |
| 运维成本 | 高 | 零 |
| 写作体验 | 后台编辑器 | 任意编辑器写 md |

> 静态方案牺牲的只是"在线即时修改后台"的能力,换来的却是零运维和极致加载速度——对个人博客,这笔交易血赚。
