// data/projects.ts — 项目展示数据(改这里)
export interface Project {
  name: string;
  description: string;
  stack: string[];
  link: string;
  repo?: string;
  emoji: string;
}

export const projects: Project[] = [
  {
    name: "LAN ISLAND",
    description: "这座博客本身:Next.js 16 静态生成、零数据库、毛玻璃 + 极光设计。",
    stack: ["Next.js 16", "Tailwind 4", "Vercel"],
    link: "/",
    repo: "https://github.com",
    emoji: "🏝️",
  },
  {
    name: "示例项目",
    description: "把你的项目加进 data/projects.ts,一张卡片就是一个作品。",
    stack: ["TypeScript", "Node.js"],
    link: "https://example.com",
    repo: "https://github.com",
    emoji: "🧩",
  },
];
