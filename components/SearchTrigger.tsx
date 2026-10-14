"use client";

// components/SearchTrigger.tsx — 顶部搜索按钮 + Ctrl+K 快捷键 + 弹窗挂载
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import SearchModal, { type SearchItem } from "./SearchModal";

export default function SearchTrigger({ items }: { items: SearchItem[] }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button
        aria-label="搜索"
        onClick={() => setOpen(true)}
        className="hidden items-center gap-2 rounded-full border border-white/30 bg-white/40 px-3.5 py-1.5 text-xs font-bold text-slate-500 transition-all hover:border-indigo-400 hover:text-indigo-500 dark:border-white/10 dark:bg-white/5 dark:text-slate-400 sm:flex"
      >
        <Search size={14} />
        搜索
        <kbd className="rounded border border-white/30 bg-white/50 px-1.5 py-0.5 text-[10px] dark:border-white/10 dark:bg-white/10">
          Ctrl K
        </kbd>
      </button>
      <SearchModal open={open} onClose={() => setOpen(false)} items={items} />
    </>
  );
}
