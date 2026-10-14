// app/tags/page.tsx — 标签云(服务端组件)
import Link from "next/link";
import { Tags } from "lucide-react";
import { getTagMap } from "@/lib/posts";

export const metadata = { title: "标签" };

export default async function TagsPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  const { t } = await searchParams;
  const tags = getTagMap();
  const max = Math.max(...tags.map((x) => x.count), 1);
  // t 参数:选中某个标签后跳到对应筛选页;纯锚点用于从首页跳来
  const selected = t || null;

  return (
    <div className="flex flex-col gap-6 pb-10">
      <header className="flex items-center gap-3">
        <Tags className="text-indigo-500" size={26} />
        <div>
          <h1 className="text-2xl font-black">标签</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            共 {tags.length} 个标签 · 点击进入筛选
          </p>
        </div>
      </header>

      <div className="glass flex flex-wrap items-baseline gap-x-5 gap-y-3 rounded-3xl p-8">
        {tags.map(({ name, count }) => {
          // 按出现次数缩放字号
          const scale = 0.85 + (count / max) * 1.1;
          return (
            <Link
              key={name}
              href={`/tags/${encodeURIComponent(name)}`}
              id={name}
              style={{ fontSize: `${scale}rem` }}
              className={`font-black transition-all hover:-translate-y-0.5 ${
                selected === name
                  ? "text-indigo-500"
                  : "text-slate-500 hover:text-indigo-500 dark:text-slate-400"
              }`}
            >
              {name}
              <sup className="ml-0.5 text-xs font-bold text-indigo-400">{count}</sup>
            </Link>
          );
        })}
        {tags.length === 0 && (
          <p className="text-sm text-slate-400">还没有任何标签</p>
        )}
      </div>
    </div>
  );
}
