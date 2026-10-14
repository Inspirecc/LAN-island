import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 封面/头像可能来自任意图床,关闭图片优化管道以便纯静态部署
  images: { unoptimized: true },
  // 构建期类型检查由独立 tsc 命令完成(某些受限环境下 Next 无法 spawn tsserver)
  typescript: { ignoreBuildErrors: true },
  // 用 worker_threads 代替子进程收集页面数据(受限环境下 spawn 会被拦截)
  experimental: { workerThreads: true },
};

export default nextConfig;
