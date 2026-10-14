"use client";

// components/PhotoGrid.tsx — 相册照片网格 + 灯箱
"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import type { Photo } from "@/data/albums";

export default function PhotoGrid({ photos }: { photos: Photo[] }) {
  const [active, setActive] = useState<number | null>(null);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setActive(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {photos.map((p, i) => (
          <button
            key={i}
            onClick={() => setActive(i)}
            className="group relative aspect-square overflow-hidden rounded-2xl border border-white/30 dark:border-white/10"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={p.src}
              alt={p.caption || ""}
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-110"
            />
            {p.caption && (
              <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-2 text-left text-xs text-white opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                {p.caption}
              </span>
            )}
          </button>
        ))}
      </div>

      <AnimatePresence>
        {active !== null && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
            onClick={() => setActive(null)}
          >
            <motion.img
              initial={{ scale: 0.9 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.9 }}
              src={photos[active].src}
              alt={photos[active].caption || ""}
              className="max-h-[85vh] max-w-full rounded-2xl object-contain shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              aria-label="关闭"
              className="absolute right-6 top-6 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
              onClick={() => setActive(null)}
            >
              <X size={22} />
            </button>
            {photos[active].caption && (
              <p className="absolute bottom-6 text-sm text-white/80">
                {photos[active].caption}
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
