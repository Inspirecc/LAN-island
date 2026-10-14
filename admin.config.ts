// admin.config.ts — 后台配置:仓库、分支、目录
export const adminConfig = {
  /** GitHub 仓库(线上模式下后台通过 GitHub API 提交) */
  repo: "Inspirecc/LAN-island",
  /** 提交分支 */
  branch: "main",
  postsDir: "posts",
  momentsDir: "moments",
  dataDir: "data",
  uploadsDir: "public/uploads",
  uploadsPublicPath: "/uploads",
};
