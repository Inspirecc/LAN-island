// components/SiteStats.tsx — 首页站点数据小组件(服务端组件)
import { CalendarDays, FileText, MessageCircle, Tag } from "lucide-react";
import { daysSince } from "@/lib/posts";
import { siteConfig } from "@/siteConfig";

export default function SiteStats({
  postCount,
  momentCount,
  tagCount,
}: {
  postCount: number;
  momentCount: number;
  tagCount: number;
}) {
  const items = [
    { icon: FileText, label: "文章", value: postCount },
    { icon: MessageCircle, label: "说说", value: momentCount },
    { icon: Tag, label: "标签", value: tagCount },
    { icon: CalendarDays, label: "运行天数", value: daysSince(siteConfig.buildDate) },
  ];
  return (
    <section className="grid grid-cols-2 gap-4">
      {items.map(({ icon: Icon, label, value }) => (
        <div
          key={label}
          className="glass flex items-center gap-3 rounded-2xl p-4 transition-transform duration-300 hover:-translate-y-1"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-aurora text-white shadow-lg">
            <Icon size={18} />
          </div>
          <div>
            <p className="text-lg font-black leading-none">{value}</p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{label}</p>
          </div>
        </div>
      ))}
    </section>
  );
}
