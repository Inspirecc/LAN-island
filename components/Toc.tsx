// components/Toc.tsx — 文章目录(客户端:从渲染 HTML 提取标题 + 滚动高亮)
"use client";

import { useEffect, useMemo, useState } from "react";
import { ListTree } from "lucide-react";

interface TocItem {
  id: string;
  text: string;
  level: number;
}

export default function Toc({ html }: { html: string }) {
  const items = useMemo<TocItem[]>(() => {
    const heads: TocItem[] = [];
    // 仅在客户端用 DOM 解析;服务端首帧用正则兜底
    if (typeof window !== "undefined") {
      const doc = new DOMParser().parseFromString(html, "text/html");
      doc.querySelectorAll("h2, h3").forEach((h) => {
        heads.push({
          id: h.id,
          text: h.textContent || "",
          level: h.tagName === "H2" ? 2 : 3,
        });
      });
      return heads;
    }
    // SSR 兜底:从 HTML 字符串粗提取
    const re = /<h([23])[^>]*>(.*?)<\/h\1>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const text = m[2].replace(/<[^>]+>/g, "");
      heads.push({ id: text, text, level: Number(m[1]) });
    }
    return heads;
  }, [html]);

  const [activeId, setActiveId] = useState("");

  useEffect(() => {
    if (items.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActiveId(e.target.id);
        }
      },
      { rootMargin: "-80px 0px -70% 0px" }
    );
    items.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [items]);

  if (items.length === 0) return null;

  return (
    <nav className="glass sticky top-24 max-h-[70vh] overflow-auto rounded-2xl p-5">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-black">
        <ListTree size={15} className="text-indigo-500" /> 目录
      </h3>
      <ul className="flex flex-col gap-1 text-sm">
        {items.map((item, i) => (
          <li key={`${item.id}-${i}`}>
            <a
              href={`#${item.id}`}
              className={`block rounded-lg px-2 py-1 transition-colors ${
                item.level === 3 ? "pl-6 text-xs" : ""
              } ${
                activeId === item.id
                  ? "bg-indigo-500/10 font-bold text-indigo-500"
                  : "text-slate-500 hover:text-indigo-500 dark:text-slate-400"
              }`}
            >
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
