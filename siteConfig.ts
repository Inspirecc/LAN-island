// siteConfig.ts — LAN ISLAND 全站配置中心
// 改名字、头像、社交链接、特效开关,都在这一个文件里。

export const siteConfig = {
  /** 站点名 */
  title: "LAN ISLAND",
  /** 副标题 */
  subtitle: "一座属于自己的小岛",
  /** 导航栏 Logo 文案 */
  navTitle: "LAN ISLAND",
  /** SEO 描述 */
  description:
    "LAN ISLAND —— 记录技术、生活与灵感的个人小岛。文章、说说、摄影与项目。",
  /** 站点地址(部署后改成你的正式域名,用于 SEO 与 RSS) */
  siteUrl: "https://lan-island.vercel.app",
  /** 作者名 */
  author: "LAN",
  /** 头像(可换成本地 /avatar.jpg,放 public 目录) */
  avatarUrl: "https://api.dicebear.com/9.x/glass/svg?seed=LANISLAND",
  /** 个性签名 */
  bio: "在代码与生活的缝隙里,捡拾发光的碎片。",

  /** 社交链接(留空则不显示) */
  social: {
    github: "https://github.com",
    email: "",
    bilibili: "",
    x: "",
    zhihu: "",
  },

  /** 建站日期(用于"运行天数"统计) */
  buildDate: "2026-01-01",
  /** 页脚备案号(留空不显示) */
  icp: "",

  /** 视觉与特效开关 */
  effects: {
    /** 极光渐变背景 */
    auroraBackground: true,
    /** 樱花粒子(默认关) */
    sakura: false,
    /** 萤火虫粒子(默认关) */
    fireflies: false,
  },

  /** 页脚徽章 */
  footerBadges: ["Next.js 16", "Tailwind CSS 4", "Vercel"],
} as const;

export type SiteConfig = typeof siteConfig;
