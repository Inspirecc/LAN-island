// app/projects/page.tsx — 项目展示(服务端组件)
import { FolderKanban, Github, Link2 } from "lucide-react";
import { getProjects } from "@/lib/data";

export const metadata = { title: "项目" };

export default function ProjectsPage() {
  const projects = getProjects();
  return (
    <div className="flex flex-col gap-6 pb-10">
      <header className="flex items-center gap-3">
        <FolderKanban className="text-indigo-500" size={26} />
        <div>
          <h1 className="text-2xl font-black">项目</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {projects.length} 个作品 · 岛上的造物
          </p>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        {projects.map((p) => (
          <article
            key={p.name}
            className="glass group flex flex-col gap-3 rounded-3xl p-6 transition-all duration-300 hover:-translate-y-1"
          >
            <div className="flex items-center justify-between">
              <span className="text-3xl transition-transform duration-500 group-hover:scale-125 group-hover:-rotate-6">
                {p.emoji}
              </span>
              <div className="flex gap-2">
                {p.repo && (
                  <a
                    href={p.repo}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="源码"
                    className="rounded-full p-2 text-slate-400 transition-colors hover:bg-white/40 hover:text-indigo-500 dark:hover:bg-white/10"
                  >
                    <Github size={17} />
                  </a>
                )}
                <a
                  href={p.link}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="访问"
                  className="rounded-full p-2 text-slate-400 transition-colors hover:bg-white/40 hover:text-indigo-500 dark:hover:bg-white/10"
                >
                  <Link2 size={17} />
                </a>
              </div>
            </div>
            <h2 className="text-lg font-black group-hover:text-indigo-500">{p.name}</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">{p.description}</p>
            <div className="mt-auto flex flex-wrap gap-2 pt-2">
              {p.stack.map((s) => (
                <span
                  key={s}
                  className="rounded-full border border-white/30 bg-white/40 px-2.5 py-0.5 text-xs font-bold text-slate-500 dark:border-white/10 dark:bg-white/5 dark:text-slate-300"
                >
                  {s}
                </span>
              ))}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
