// app/message/page.tsx — 留言板(服务端组件 + giscus 承载留言)
import { MessagesSquare } from "lucide-react";
import Comments from "@/components/Comments";

export const metadata = { title: "留言板" };

export default function MessagePage() {
  return (
    <div className="flex flex-col gap-6 pb-10">
      <header className="flex items-center gap-3">
        <MessagesSquare className="text-indigo-500" size={26} />
        <div>
          <h1 className="text-2xl font-black">留言板</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            给岛上扔一个漂流瓶
          </p>
        </div>
      </header>
      <Comments />
    </div>
  );
}
