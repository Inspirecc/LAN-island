// app/moments/page.tsx — 说说流(服务端组件,Markdown 短内容)
import { MessageCircleHeart } from "lucide-react";
import { formatDate, getAllMoments, markdownToHtml } from "@/lib/posts";

export const metadata = { title: "说说" };

export default async function MomentsPage() {
  const moments = getAllMoments();
  const htmls = await Promise.all(moments.map((m) => markdownToHtml(m.content)));

  return (
    <div className="flex flex-col gap-6 pb-10">
      <header className="flex items-center gap-3">
        <MessageCircleHeart className="text-pink-400" size={26} />
        <div>
          <h1 className="text-2xl font-black">说说</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {moments.length} 条碎片 · 潮水带来的只言片语
          </p>
        </div>
      </header>

      <div className="relative ml-3 flex flex-col gap-6 border-l-2 border-pink-300/30 pl-8">
        {moments.map((m, i) => (
          <article key={m.slug} className="relative">
            <span className="absolute -left-[41px] top-6 h-3 w-3 rounded-full border-2 border-pink-400 bg-white shadow dark:bg-slate-900" />
            <div className="glass rounded-3xl p-6">
              <div className="flex items-center justify-between text-xs text-slate-400 dark:text-slate-500">
                <span>{formatDate(m.date)}</span>
                {m.tags.length > 0 && (
                  <span className="rounded-full bg-pink-500/10 px-2.5 py-0.5 font-bold text-pink-400">
                    #{m.tags[0]}
                  </span>
                )}
              </div>
              {m.cover && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={m.cover}
                  alt=""
                  className="mt-3 max-h-72 w-full rounded-2xl object-cover"
                />
              )}
              <div
                className="prose prose-slate dark:prose-invert mt-3 max-w-none text-sm"
                dangerouslySetInnerHTML={{ __html: htmls[i] }}
              />
            </div>
          </article>
        ))}
        {moments.length === 0 && (
          <p className="glass rounded-3xl p-10 text-center text-sm text-slate-400">
            还没有说说,往 moments\ 文件夹丢一个 .md 就有了
          </p>
        )}
      </div>
    </div>
  );
}
