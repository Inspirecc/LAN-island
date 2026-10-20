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
  siteUrl: "https://moonlan.space",
  /** 作者名 */
  author: "LAN",
  /** 头像(可换成本地 /avatar.jpg,放 public 目录) */
  avatarUrl: "https://api.dicebear.com/9.x/glass/svg?seed=LANISLAND",
  /** 个性签名 */
  bio: "Java 后端 / AI 应用。在这里记录技术与踩坑。",

  /** 社交链接(留空则不显示) */
  social: {
    github: "https://github.com/Inspirecc",
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

  /** 悬浮音乐播放器 */
  music: {
    /** 是否启用 */
    enabled: true,
    /** 默认音量 0~1 */
    defaultVolume: 0.6,
    /**
     * 歌单:url 两种写法——
     * 1. 本地文件:mp3 放进 public/music/ 后写 "/music/xxx.mp3"
     * 2. 外链:如 SoundHelix 试音曲,或网易云外链 "https://music.163.com/song/media/outer/url?id=歌曲ID.mp3"(仅免费歌曲可用)
     * 注意:请使用有版权/授权的音乐,不要上传盗版音源
     */
    playlist: [
      {
        title: "Island Breeze",
        artist: "SoundHelix",
        url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
        cover: "",
      },
      {
        title: "Night Walk",
        artist: "SoundHelix",
        url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3",
        cover: "",
      },
      {
        title: "Deep Blue",
        artist: "SoundHelix",
        url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3",
        cover: "",
      },
    ],
  },
} as const;

export type SiteConfig = typeof siteConfig;
