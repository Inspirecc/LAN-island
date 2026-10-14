"use client";

// components/SearchModal.tsx — Ctrl+K 全站搜索弹窗
import { AnimatePresence, motion } from "framer-motion";
import { Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

export interface SearchItem {
  title: string;
  slug: string;
  category: string;
  description: string;
}

export default function SearchModal({
  open,
  onClose,
  items,
}: {
  open: boolean;
  onClose: () => void;
  items: SearchItem[];
}) {
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const results = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return items.slice(0, 8);
    return items
      .filter(
        (it) =>
          it.title.toLowerCase().includes(kw) ||
          it.description.toLowerCase().includes(kw) ||
          it.category.toLowerCase().includes(kw)
      )
      .slice(0, 8);
  }, [q, items]);

  useEffect(() => {
    if (open) {
      setQ("");
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const go = (slug: string) => {
    onClose();
    router.push(`/posts/${slug}`);
  };

  // 键盘导航
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter" && results[cursor]) {
      go(results[cursor].slug);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[70] flex items-start justify-center bg-black/40 px-4 pt-24 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ y: -16, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: -16, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 300, damping: 26 }}
            className="glass w-full max-w-xl overflow-hidden rounded-3xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-white/20 px-5 py-4 dark:border-white/10">
              <Search size={18} className="shrink-0 text-indigo-500" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setCursor(0);
                }}
                onKeyDown={onKeyDown}
                placeholder="搜索文章…(标题 / 摘要 / 分类)"
                className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400"
              />
              <button
                aria-label="关闭"
                onClick={onClose}
                className="rounded-full p-1 text-slate-400 transition-colors hover:bg-white/40 dark:hover:bg-white/10"
              >
                <X size={16} />
              </button>
            </div>
            <ul className="max-h-80 overflow-auto p-2">
              {results.map((it, i) => (
                <li key={it.slug}>
                  <button
                    onClick={() => go(it.slug)}
                    onMouseEnter={() => setCursor(i)}
                    className={`flex w-full flex-col items-start gap-0.5 rounded-2xl px-4 py-3 text-left transition-colors ${
                      i === cursor ? "bg-indigo-500/10" : ""
                    }`}
                  >
                    <span className="text-sm font-bold">
                      {it.title}
                      <span className="ml-2 text-xs font-bold text-indigo-500">
                        {it.category}
                      </span>
                    </span>
                    <span className="line-clamp-1 text-xs text-slate-500 dark:text-slate-400">
                      {it.description}
                    </span>
                  </button>
                </li>
              ))}
              {results.length === 0 && (
                <li className="px-4 py-8 text-center text-sm text-slate-400">
                  没有找到相关文章
                </li>
              )}
            </ul>
            <div className="flex items-center gap-4 border-t border-white/20 px-5 py-2.5 text-[10px] text-slate-400 dark:border-white/10">
              <span>↑↓ 选择</span>
              <span>↵ 打开</span>
              <span>ESC 关闭</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
