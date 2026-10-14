// app/friends/page.tsx — 友链(服务端组件)
import { HeartHandshake } from "lucide-react";
import { friends } from "@/data/friends";

export const metadata = { title: "友链" };

export default function FriendsPage() {
  return (
    <div className="flex flex-col gap-6 pb-10">
      <header className="flex items-center gap-3">
        <HeartHandshake className="text-indigo-500" size={26} />
        <div>
          <h1 className="text-2xl font-black">友链</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {friends.length} 座邻近的小岛 · 交换链接请提 Issue 或来信
          </p>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {friends.map((f) => (
          <a
            key={f.url}
            href={f.url}
            target="_blank"
            rel="noreferrer"
            className="glass group flex items-center gap-4 rounded-2xl p-5 transition-all duration-300 hover:-translate-y-1"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={f.avatar}
              alt={f.name}
              className="h-14 w-14 rounded-2xl border border-white/40 dark:border-white/10"
            />
            <div className="min-w-0">
              <p className="truncate font-bold transition-colors group-hover:text-indigo-500">
                {f.name}
              </p>
              <p className="line-clamp-2 text-xs text-slate-500 dark:text-slate-400">
                {f.description}
              </p>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
