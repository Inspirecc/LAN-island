// data/friends.ts — 友链数据(改这里)
export interface Friend {
  name: string;
  url: string;
  avatar: string;
  description: string;
}

export const friends: Friend[] = [
  {
    name: "Aurora 博客",
    url: "https://www.linhaojun.top",
    avatar: "https://api.dicebear.com/9.x/glass/svg?seed=aurora",
    description: "极光一样好看的开源博客系统作者",
  },
  {
    name: "XingHuiSama",
    url: "https://www.xinghuisama.top",
    avatar: "https://api.dicebear.com/9.x/glass/svg?seed=xinghui",
    description: "毛玻璃次元博主,灵境工坊主理人",
  },
  {
    name: "示例友链",
    url: "https://example.com",
    avatar: "https://api.dicebear.com/9.x/glass/svg?seed=example",
    description: "把你的朋友加进 data/friends.ts",
  },
];
