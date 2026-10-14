// components/Comments.tsx — giscus 评论(客户端加载;未配置时显示占位说明)
"use client";

import { useEffect, useRef, useState } from "react";
import { MessageSquareHeart } from "lucide-react";

// 部署时把 siteConfig 填好 giscus 后自动启用;这里读取环境变量/常量
const GISCUS = {
  repo: process.env.NEXT_PUBLIC_GISCUS_REPO || "",
  repoId: process.env.NEXT_PUBLIC_GISCUS_REPO_ID || "",
  category: process.env.NEXT_PUBLIC_GISCUS_CATEGORY || "Announcements",
  categoryId: process.env.NEXT_PUBLIC_GISCUS_CATEGORY_ID || "",
};

export default function Comments() {
  const ref = useRef<HTMLDivElement>(null);
  const [ready] = useState(Boolean(GISCUS.repo && GISCUS.repoId));

  useEffect(() => {
    if (!ready || !ref.current) return;
    const s = document.createElement("script");
    s.src = "https://giscus.app/client.js";
    s.async = true;
    s.crossOrigin = "anonymous";
    s.setAttribute("data-repo", GISCUS.repo);
    s.setAttribute("data-repo-id", GISCUS.repoId);
    s.setAttribute("data-category", GISCUS.category);
    s.setAttribute("data-category-id", GISCUS.categoryId);
    s.setAttribute("data-mapping", "pathname");
    s.setAttribute("data-strict", "0");
    s.setAttribute("data-reactions-enabled", "1");
    s.setAttribute("data-emit-metadata", "0");
    s.setAttribute("data-input-position", "top");
    s.setAttribute("data-theme", "preferred_color_scheme");
    s.setAttribute("data-lang", "zh-CN");
    ref.current.appendChild(s);
  }, [ready]);

  return (
    <section className="glass rounded-3xl p-6 sm:p-10">
      <h3 className="mb-4 flex items-center gap-2 text-lg font-black">
        <MessageSquareHeart size={18} className="text-pink-400" /> 留下点什么
      </h3>
      {ready ? (
        <div ref={ref} />
      ) : (
        <p className="text-sm text-slate-400">
          评论基于 GitHub Discussions(giscus)。在项目根目录配置
          <code className="mx-1 rounded bg-slate-500/10 px-1.5 py-0.5 text-xs">
            .env.local
          </code>
          填入 NEXT_PUBLIC_GISCUS_* 四个变量后自动开启。
        </p>
      )}
    </section>
  );
}
