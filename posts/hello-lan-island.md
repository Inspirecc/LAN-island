---
title: 你好,LAN ISLAND
date: 2026-01-01
description: 这是博客的第一篇文章,介绍这座小岛是怎么建起来的。
tags: [随笔, Next.js]
category: 随笔
top: true
---

欢迎来到 **LAN ISLAND**——我在互联网上的一座小岛。

这座岛没有数据库,没有沉重的后端,只有一堆 Markdown 文件和一个 Next.js 静态站。写文章,就是往 `posts\` 文件夹里丢一个 `.md` 文件;推送到 GitHub,Vercel 会自动构建发布。

## 为什么叫这个名字

LAN 是我的姓氏,ISLAND 是属于自己的一座小岛。潮水(热点)来了又去,岛一直在这里。

## 这座岛怎么造的

- **视觉**:毛玻璃卡片 + 极光渐变背景,参考了 Aurora 和 XHBlogs 两个开源博客
- **技术**:Next.js 16 静态生成 + Tailwind CSS 4,亮暗主题跟随系统
- **写作**:Markdown + front-matter,支持置顶、分类、标签

## 写作格式

```markdown
---
title: 文章标题
date: 2025-01-01
description: 一句话摘要
tags: [标签1, 标签2]
category: 分类
top: true   # 可选,置顶
---
正文支持 **GFM**、代码高亮、表格。
```

愿我们都在自己的岛上,慢慢捡拾发光的碎片。🏝️
