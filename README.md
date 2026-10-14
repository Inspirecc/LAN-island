# LAN ISLAND 🏝️

> 一座属于自己的小岛 —— Next.js 16 静态博客,零数据库,Markdown 即文章。

参考 [Aurora](https://github.com/zhouyqxy/aurora)(极光配色、卡片+侧栏)与 [XHBlogs](https://github.com/Xinghuisama/XingHuisamaBlogs)(毛玻璃 Bento、氛围特效)两家之长。

## 快速开始

```bash
# 安装依赖(任选其一)
pnpm install          # 本机 Node 24 + pnpm 11
npm install

# 本地开发
pnpm dev              # http://localhost:3000

# 构建 + 生产运行
pnpm build && pnpm start
```

> Windows 下若 pnpm 符号链接报错,加 `--node-linker=hoisted`。

## 写文章 / 发说说

**写文章** = 在 `posts\` 新建 `my-post.md`:

```markdown
---
title: 文章标题
date: 2026-01-01
description: 一句话摘要(可省略,默认取正文开头)
cover: /covers/xxx.jpg   # 可选
tags: [标签1, 标签2]
category: 分类            # 可选,默认「随笔」
top: true                 # 可选,置顶
---
正文支持 GFM、代码高亮、表格……
```

**发说说** = 在 `moments\` 新建 .md,front-matter 同上(`cover` 为配图)。

**加友链 / 相册 / 项目** = 改 `data\friends.ts` / `data\albums.ts` / `data\projects.ts`。

## 全站配置

一切个性化都在根目录 `siteConfig.ts`:站名、头像、签名、社交链接、建站日期、ICP、特效开关(极光背景 / 樱花 / 萤火虫)。

## 评论(giscus)

1. 让仓库开启 Discussions,并安装 [giscus App](https://github.com/apps/giscus)
2. 到 [giscus.app](https://giscus.app/zh-CN) 生成四个参数
3. 在 `.env.local`(本地)或 Vercel 环境变量里配置:

```
NEXT_PUBLIC_GISCUS_REPO=你的用户名/仓库
NEXT_PUBLIC_GISCUS_REPO_ID=R_xxxxx
NEXT_PUBLIC_GISCUS_CATEGORY=Announcements
NEXT_PUBLIC_GISCUS_CATEGORY_ID=DIC_xxxxx
```

配置后文章页与留言板自动出现评论区。

## 部署到 Vercel(免费)

1. 代码推到 GitHub
2. [vercel.com](https://vercel.com) 用 GitHub 登录 → Import 本仓库 → Deploy(零配置)
3. 每次 `git push` 自动发布;预览链接见 Vercel 控制台
4. 大陆访问慢?绑自有域名,或改用 Cloudflare Pages

## 目录结构

```
lan-island/
├── app/            # 页面(首页/文章/说说/相册/项目/归档/标签/友链/关于/留言)
├── components/     # UI 组件(导航/卡片/搜索/TOC/评论/特效…)
├── lib/            # Markdown 解析与数据函数
├── data/           # 友链/相册/项目配置
├── posts/          # ★ 文章
├── moments/        # ★ 说说
├── public/         # 静态资源(头像/封面/照片)
└── siteConfig.ts   # ★ 全站配置中心
```
