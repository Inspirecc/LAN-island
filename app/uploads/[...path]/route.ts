// app/uploads/[...path]/route.ts — 上传图片的读取服务
// next start 启动后新增的 public 文件不会被静态服务,所以图片走这个路由。
// 线上(GitHub 模式)从仓库读,本地从磁盘读,都带长缓存。
import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { adminConfig } from "@/admin.config";
import { readFile, useGitHub } from "@/lib/admin-store";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
};

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ path: string[] }> }
) {
  const { path: segments } = await ctx.params;
  const filename = segments.join("/");
  // 防目录穿越
  if (filename.includes("..")) {
    return new NextResponse("bad path", { status: 400 });
  }

  const ext = (filename.split(".").pop() || "").toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const rel = `${adminConfig.uploadsDir}/${filename}`;

  if (useGitHub()) {
    const res = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPO || adminConfig.repo}/contents/${rel}?ref=${adminConfig.branch}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "lan-island",
        },
        next: { revalidate: 3600 },
      }
    );
    if (!res.ok) return new NextResponse("not found", { status: 404 });
    const json = (await res.json()) as { content?: string };
    if (!json.content) return new NextResponse("not found", { status: 404 });
    return new NextResponse(Buffer.from(json.content, "base64"), {
      headers: {
        "Content-Type": type,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  const abs = path.join(process.cwd(), rel);
  if (!fs.existsSync(abs)) return new NextResponse("not found", { status: 404 });
  return new NextResponse(fs.readFileSync(abs), {
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
