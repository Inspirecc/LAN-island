// components/BackButton.tsx — 返回上一页(客户端)
"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

export default function BackButton() {
  const router = useRouter();
  return (
    <button
      onClick={() => router.back()}
      className="flex w-fit items-center gap-1.5 text-sm font-bold text-slate-500 transition-colors hover:text-indigo-500 dark:text-slate-400"
    >
      <ArrowLeft size={15} /> 返回
    </button>
  );
}
