// lib/admin-api.ts — 后台 API 路由集合(单文件,避免大量小文件)
// 所有接口都在 /api/admin/*,统一鉴权。
import { NextRequest, NextResponse } from "next/server";
import { adminConfig } from "@/admin.config";
import {
  listFiles,
  readFile,
  writeFile,
  deleteFile,
  useGitHub,
} from "@/lib/admin-store";
import {
  ADMIN_COOKIE,
  adminEnabled,
  checkPassword,
  isAuthed,
  makeToken,
} from "@/lib/admin-auth";

const JSON_HEADERS = { "Content-Type": "application/json" };

function ok(data: unknown) {
  return new NextResponse(JSON.stringify(data), { headers: JSON_HEADERS });
}

function bad(message: string, status = 400) {
  return new NextResponse(JSON.stringify({ error: message }), {
    status,
    headers: JSON_HEADERS,
  });
}

function slugify(input: string): string {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\w\u4e00-\u9fa5-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || `untitled-${Date.now()}`;
}

/** 把文章字段序列化成 Markdown(front-matter + 正文) */
function toMarkdown(meta: Record<string, unknown>, body: string): string {
  const lines: string[] = ["---"];
  const push = (k: string, v: unknown) => {
    if (v === undefined || v === null || v === "") return;
    if (Array.isArray(v)) {
      if (v.length === 0) return;
      lines.push(`${k}: [${v.map((x) => String(x)).join(", ")}]`);
    } else if (typeof v === "boolean") {
      lines.push(`${k}: ${v}`);
    } else {
      lines.push(`${k}: ${String(v)}`);
    }
  };
  push("title", meta.title);
  push("date", meta.date);
  push("description", meta.description);
  push("cover", meta.cover);
  push("tags", meta.tags);
  push("category", meta.category);
  push("top", meta.top);
  lines.push("---", "", body.trim(), "");
  return lines.join("\n");
}

/** 极简 front-matter 解析(后台列表用,不引依赖) */
function parseMarkdown(raw: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { meta: {} as Record<string, unknown>, body: raw };
  const meta: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, key, rawValue] = m;
    let value: unknown = rawValue.trim().replace(/^["']|["']$/g, "");
    if (/^\[.*\]$/.test(rawValue.trim())) {
      value = rawValue
        .trim()
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else if (value === "true") value = true;
    else if (value === "false") value = false;
    meta[key] = value;
  }
  return { meta, body: match[2] };
}

type Ctx = { params: Promise<{ action?: string[] }> };

export async function handleAdmin(req: NextRequest, ctx: Ctx) {
  const { action } = await ctx.params;
  const route = (action ?? []).join("/");
  const method = req.method;

  if (!adminEnabled()) {
    return bad("后台未启用:请在环境变量中配置 ADMIN_PASSWORD", 503);
  }

  // ---- 登录 / 登出 ----
  if (route === "login" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { password?: string };
    if (!checkPassword(body.password)) return bad("密码错误", 401);
    const res = ok({ ok: true, mode: useGitHub() ? "github" : "local" });
    // 仅 HTTPS 下加 Secure,否则 http://localhost 会带不上 cookie
    const proto =
      req.headers.get("x-forwarded-proto") || req.nextUrl.protocol.replace(":", "");
    const secure = proto === "https" ? "; Secure" : "";
    res.headers.append(
      "Set-Cookie",
      `${ADMIN_COOKIE}=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
        7 * 86400
      }${secure}`
    );
    return res;
  }

  if (route === "logout" && method === "POST") {
    const res = ok({ ok: true });
    res.headers.append(
      "Set-Cookie",
      `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
    );
    return res;
  }

  // 以下接口都要登录
  if (!(await isAuthed())) return bad("未登录", 401);

  if (route === "session" && method === "GET") {
    return ok({ authed: true, mode: useGitHub() ? "github" : "local" });
  }

  // ---- 文章 ----
  if (route === "posts" && method === "GET") {
    const files = await listFiles(adminConfig.postsDir);
    const items = [] as Record<string, unknown>[];
    for (const f of files.filter((x) => x.endsWith(".md"))) {
      const raw = await readFile(`${adminConfig.postsDir}/${f}`);
      if (!raw) continue;
      const { meta } = parseMarkdown(raw);
      items.push({ slug: f.replace(/\.md$/, ""), ...meta });
    }
    return ok({ items });
  }

  if (route === "posts" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const slug = slugify(String(body.slug || body.title || ""));
    const md = toMarkdown(body, String(body.content || ""));
    await writeFile(
      `${adminConfig.postsDir}/${slug}.md`,
      md,
      `post: ${body.title || slug}`
    );
    return ok({ ok: true, slug });
  }

  if (route.startsWith("posts/") && method === "GET") {
    const slug = decodeURIComponent(route.slice("posts/".length));
    const raw = await readFile(`${adminConfig.postsDir}/${slug}.md`);
    if (raw === null) return bad("文章不存在", 404);
    const { meta, body } = parseMarkdown(raw);
    return ok({ slug, ...meta, content: body });
  }

  if (route.startsWith("posts/") && method === "DELETE") {
    const slug = decodeURIComponent(route.slice("posts/".length));
    await deleteFile(`${adminConfig.postsDir}/${slug}.md`, `delete post: ${slug}`);
    return ok({ ok: true });
  }

  // ---- 说说 ----
  if (route === "moments" && method === "GET") {
    const files = await listFiles(adminConfig.momentsDir);
    const items = [] as Record<string, unknown>[];
    for (const f of files.filter((x) => x.endsWith(".md"))) {
      const raw = await readFile(`${adminConfig.momentsDir}/${f}`);
      if (!raw) continue;
      const { meta, body } = parseMarkdown(raw);
      items.push({ slug: f.replace(/\.md$/, ""), ...meta, content: body });
    }
    return ok({ items });
  }

  if (route === "moments" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const slug = slugify(String(body.slug || body.title || `moment-${Date.now()}`));
    const md = toMarkdown(body, String(body.content || ""));
    await writeFile(
      `${adminConfig.momentsDir}/${slug}.md`,
      md,
      `moment: ${body.title || slug}`
    );
    return ok({ ok: true, slug });
  }

  if (route.startsWith("moments/") && method === "DELETE") {
    const slug = decodeURIComponent(route.slice("moments/".length));
    await deleteFile(
      `${adminConfig.momentsDir}/${slug}.md`,
      `delete moment: ${slug}`
    );
    return ok({ ok: true });
  }

  // ---- 数据文件(友链/项目/相册) ----
  if (route.startsWith("data/") && method === "GET") {
    const name = route.slice("data/".length);
    const raw = await readFile(`${adminConfig.dataDir}/${name}.json`);
    return ok({ name, content: raw ?? "{}" });
  }

  if (route.startsWith("data/") && method === "PUT") {
    const name = route.slice("data/".length);
    const body = (await req.json().catch(() => ({}))) as { content?: string };
    if (typeof body.content !== "string") return bad("缺少 content");
    try {
      JSON.parse(body.content);
    } catch {
      return bad("不是合法 JSON");
    }
    await writeFile(
      `${adminConfig.dataDir}/${name}.json`,
      body.content,
      `data: update ${name}`
    );
    return ok({ ok: true });
  }

  // ---- 图片上传 ----
  if (route === "upload" && method === "POST") {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return bad("没有收到文件");
    if (file.size > 5 * 1024 * 1024) return bad("图片超过 5MB");
    const ext = (file.name.split(".").pop() || "png").toLowerCase();
    const safeExt = /^(png|jpe?g|gif|webp|avif|svg)$/.test(ext) ? ext : "png";
    const base = slugify(file.name.replace(/\.[^.]+$/, ""));
    const filename = `${base}-${Date.now().toString(36)}.${safeExt}`;
    const buf = Buffer.from(await file.arrayBuffer());
    await writeFile(
      `${adminConfig.uploadsDir}/${filename}`,
      buf.toString("base64"),
      `upload: ${filename}`,
      true
    );
    return ok({
      ok: true,
      url: `${adminConfig.uploadsPublicPath}/${filename}`,
    });
  }

  return bad("未知接口", 404);
}
