// app/posts/page.tsx — 文章列表(分类 Tab 筛选;服务端组件 + URL 查询参数)
import Link from "next/link";
import { BookOpen } from "lucide-react";
import { getAllPosts, getCategories } from "@/lib/posts";
import PostCard from "@/components/PostCard";

export const metadata = { title: "文章" };

export default async function PostsPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>;
}) {
  const { c } = await searchParams;
  const active = c || "全部";
  const posts = getAllPosts();
  const categories = getCategories();
  const filtered =
    active === "全部" ? posts : posts.filter((p) => p.category === active);

  return (
    <div className="flex flex-col gap-6 pb-10">
      <header className="flex items-center gap-3">
        <BookOpen className="text-indigo-500" size={26} />
        <div>
          <h1 className="text-2xl font-black">文章</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            共 {posts.length} 篇 · 在这座岛上写下的思考
          </p>
        </div>
      </header>

      {/* 分类 Tab(Aurora 风格) */}
      <nav className="glass flex flex-wrap gap-2 rounded-2xl p-2">
        {[{ name: "全部", count: posts.length }, ...categories].map((cat) => (
          <Link
            key={cat.name}
            href={cat.name === "全部" ? "/posts" : `/posts?c=${encodeURIComponent(cat.name)}`}
            className={`rounded-xl px-4 py-2 text-sm font-bold transition-all duration-300 ${
              active === cat.name
                ? "bg-aurora text-white shadow-lg"
                : "text-slate-600 hover:bg-white/40 dark:text-slate-300 dark:hover:bg-white/10"
            }`}
          >
            {cat.name}
            <span className="ml-1.5 text-xs opacity-70">{cat.count}</span>
          </Link>
        ))}
      </nav>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((p) => (
          <PostCard key={p.slug} post={p} />
        ))}
      </div>
      {filtered.length === 0 && (
        <p className="py-20 text-center text-slate-400">这个分类还没有文章</p>
      )}
    </div>
  );
}
