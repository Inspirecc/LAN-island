// app/not-found.tsx — 404 彩蛋页
import Link from "next/link";
import { Compass } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <div className="glass flex h-24 w-24 items-center justify-center rounded-full text-5xl">
        🐚
      </div>
      <h1 className="text-3xl font-black">
        <span className="text-aurora">404</span> · 迷航
      </h1>
      <p className="max-w-sm text-sm text-slate-500 dark:text-slate-400">
        你漂到了一片没有地图的海域——这座小岛的这一页不存在,或者已经被潮水带走了。
      </p>
      <Link
        href="/"
        className="glass mt-2 flex items-center gap-2 rounded-full px-6 py-2.5 text-sm font-bold transition-all hover:-translate-y-0.5 hover:text-indigo-500"
      >
        <Compass size={16} /> 回到岛上
      </Link>
    </div>
  );
}
