// lib/admin-store.ts — 后台存储层:本地用文件系统,线上用 GitHub API
// 同一套接口,两种实现,所以本地开发和生产环境行为一致。
import fs from "fs";
import path from "path";
import { adminConfig } from "@/admin.config";

export interface FileEntry {
  path: string; // 仓库相对路径,如 posts/hello.md
  content: string; // UTF-8 文本;图片为 base64
  isBinary?: boolean;
}

/** 线上模式:配置了 GitHub 令牌就走 API;否则本地文件系统 */
export function useGitHub(): boolean {
  return Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO);
}

function repo(): string {
  return process.env.GITHUB_REPO || adminConfig.repo;
}

function api(pathname: string): string {
  return `https://api.github.com/repos/${repo()}/${pathname}`;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "lan-island-admin",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// ---------- 读取 ----------

export async function readFile(relPath: string): Promise<string | null> {
  if (useGitHub()) {
    const res = await fetch(
      api(`contents/${relPath}?ref=${adminConfig.branch}`),
      { headers: headers(), cache: "no-store" }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub 读取失败 ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { content?: string; encoding?: string };
    if (!json.content) return null;
    return Buffer.from(json.content, "base64").toString("utf8");
  }
  const abs = path.join(process.cwd(), relPath);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
}

export async function listFiles(dir: string): Promise<string[]> {
  if (useGitHub()) {
    const res = await fetch(
      api(`contents/${dir}?ref=${adminConfig.branch}`),
      { headers: headers(), cache: "no-store" }
    );
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`GitHub 列表失败 ${res.status}`);
    const arr = (await res.json()) as { name: string; type: string }[];
    return Array.isArray(arr) ? arr.filter((f) => f.type === "file").map((f) => f.name) : [];
  }
  const abs = path.join(process.cwd(), dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter((f) => fs.statSync(path.join(abs, f)).isFile());
}

// ---------- 写入 ----------

/** GitHub 上已存在文件时需要带上 sha 才能更新 */
async function getSha(relPath: string): Promise<string | undefined> {
  const res = await fetch(
    api(`contents/${relPath}?ref=${adminConfig.branch}`),
    { headers: headers(), cache: "no-store" }
  );
  if (res.status === 404) return undefined;
  if (!res.ok) return undefined;
  const json = (await res.json()) as { sha?: string };
  return json.sha;
}

export async function writeFile(
  relPath: string,
  content: string,
  message: string,
  isBinary = false
): Promise<void> {
  if (useGitHub()) {
    const sha = await getSha(relPath);
    const res = await fetch(api(`contents/${relPath}`), {
      method: "PUT",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        content: isBinary
          ? content // 已是 base64
          : Buffer.from(content, "utf8").toString("base64"),
        branch: adminConfig.branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`GitHub 写入失败 ${res.status}: ${await res.text()}`);
    }
    return;
  }
  const abs = path.join(process.cwd(), relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, isBinary ? Buffer.from(content, "base64") : content, "utf8");
}

export async function deleteFile(relPath: string, message: string): Promise<void> {
  if (useGitHub()) {
    const sha = await getSha(relPath);
    if (!sha) return;
    const res = await fetch(api(`contents/${relPath}`), {
      method: "DELETE",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ message, sha, branch: adminConfig.branch }),
    });
    if (!res.ok) throw new Error(`GitHub 删除失败 ${res.status}`);
    return;
  }
  const abs = path.join(process.cwd(), relPath);
  if (fs.existsSync(abs)) fs.unlinkSync(abs);
}
