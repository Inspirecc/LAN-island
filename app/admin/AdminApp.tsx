"use client";

// app/admin/AdminApp.tsx — 后台管理界面(纯客户端)
import { useCallback, useEffect, useState } from "react";
import {
  FileText,
  MessageCircle,
  Database,
  LogOut,
  Plus,
  Pencil,
  Trash2,
  Upload,
  Save,
  X,
  Loader2,
  Cloud,
  HardDrive,
  ExternalLink,
} from "lucide-react";

type PostItem = {
  slug: string;
  title?: string;
  date?: string;
  category?: string;
  top?: boolean;
  description?: string;
  tags?: string[];
  cover?: string;
  content?: string;
};

type Draft = {
  slug: string;
  title: string;
  date: string;
  description: string;
  category: string;
  tags: string;
  cover: string;
  top: boolean;
  content: string;
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyDraft(kind: "posts" | "moments"): Draft {
  return {
    slug: "",
    title: "",
    date: today(),
    description: "",
    category: kind === "posts" ? "随笔" : "",
    tags: "",
    cover: "",
    top: false,
    content: "",
  };
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`/api/admin/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `请求失败 ${res.status}`);
  return data as Record<string, unknown>;
}

export default function AdminApp() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState("local");

  const [tab, setTab] = useState<"posts" | "moments" | "data">("posts");
  const [posts, setPosts] = useState<PostItem[]>([]);
  const [moments, setMoments] = useState<PostItem[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dataName, setDataName] = useState("friends");
  const [dataText, setDataText] = useState("");
  const [toast, setToast] = useState("");

  const notify = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  };

  // ---------- 会话 ----------
  const checkSession = useCallback(async () => {
    try {
      const data = await api("session");
      setAuthed(true);
      setMode(String(data.mode || "local"));
    } catch {
      setAuthed(false);
    }
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  const loadPosts = useCallback(async () => {
    const data = await api("posts");
    setPosts((data.items as PostItem[]) || []);
  }, []);

  const loadMoments = useCallback(async () => {
    const data = await api("moments");
    setMoments((data.items as PostItem[]) || []);
  }, []);

  const loadData = useCallback(async (name: string) => {
    const data = await api(`data/${name}`);
    setDataText(String(data.content || "{}"));
  }, []);

  useEffect(() => {
    if (!authed) return;
    if (tab === "posts") void loadPosts().catch((e: Error) => setError(e.message));
    if (tab === "moments") void loadMoments().catch((e: Error) => setError(e.message));
    if (tab === "data") void loadData(dataName).catch((e: Error) => setError(e.message));
  }, [authed, tab, dataName, loadPosts, loadMoments, loadData]);

  // ---------- 登录 ----------
  const login = async () => {
    setBusy(true);
    setError("");
    try {
      const data = await api("login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setMode(String(data.mode || "local"));
      setAuthed(true);
      setPassword("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await api("logout", { method: "POST" }).catch(() => {});
    setAuthed(false);
  };

  // ---------- 编辑 ----------
  const openEditor = async (kind: "posts" | "moments", slug?: string) => {
    setError("");
    if (!slug) {
      setDraft(emptyDraft(kind));
      return;
    }
    try {
      const data = await api(`${kind}/${encodeURIComponent(slug)}`);
      setDraft({
        slug: String(data.slug || slug),
        title: String(data.title || ""),
        date: String(data.date || today()).slice(0, 10),
        description: String(data.description || ""),
        category: String(data.category || ""),
        tags: Array.isArray(data.tags) ? (data.tags as string[]).join(", ") : "",
        cover: String(data.cover || ""),
        top: Boolean(data.top),
        content: String(data.content || ""),
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const saveDraft = async (kind: "posts" | "moments") => {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      await api(kind, {
        method: "POST",
        body: JSON.stringify({
          ...draft,
          tags: draft.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        }),
      });
      setDraft(null);
      notify("已保存,等待部署完成(约 1 分钟)");
      if (kind === "posts") await loadPosts();
      else await loadMoments();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (kind: "posts" | "moments", slug: string) => {
    if (!confirm(`确定删除 ${slug}?此操作会提交一次删除记录。`)) return;
    try {
      await api(`${kind}/${encodeURIComponent(slug)}`, { method: "DELETE" });
      notify("已删除");
      if (kind === "posts") await loadPosts();
      else await loadMoments();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const uploadImage = async (file: File, apply: (url: string) => void) => {
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/admin/upload", { method: "POST", body: form });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error || "上传失败");
      apply(data.url);
      notify("图片已上传");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveData = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`data/${dataName}`, {
        method: "PUT",
        body: JSON.stringify({ content: dataText }),
      });
      notify("数据已保存");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ---------- 渲染 ----------
  if (authed === null) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-slate-400">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="mx-auto flex min-h-[60vh] w-full max-w-sm flex-col justify-center">
        <div className="glass rounded-3xl p-8">
          <h1 className="text-xl font-black">
            <span className="text-aurora">LAN ISLAND</span> 后台
          </h1>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            输入管理密码登录
          </p>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && login()}
            placeholder="管理密码"
            className="mt-5 w-full rounded-xl border border-white/30 bg-white/50 px-4 py-2.5 text-sm outline-none focus:border-indigo-400 dark:border-white/10 dark:bg-white/5"
          />
          {error && <p className="mt-3 text-xs text-rose-500">{error}</p>}
          <button
            onClick={login}
            disabled={busy}
            className="bg-aurora mt-5 flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold text-white disabled:opacity-60"
          >
            {busy && <Loader2 size={14} className="animate-spin" />} 登录
          </button>
        </div>
      </div>
    );
  }

  const list = tab === "posts" ? posts : moments;
  const kind = tab === "posts" ? "posts" : "moments";

  return (
    <div className="flex flex-col gap-6 pb-16">
      {/* 头部 */}
      <header className="glass flex flex-wrap items-center justify-between gap-4 rounded-3xl p-5">
        <div>
          <h1 className="text-lg font-black">
            <span className="text-aurora">LAN ISLAND</span> 后台
          </h1>
          <p className="mt-1 flex items-center gap-2 text-xs">
            {mode === "github" ? (
              <>
                <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-0.5 font-bold text-emerald-500">
                  <Cloud size={11} /> GitHub 模式
                </span>
                <span className="text-slate-500 dark:text-slate-400">
                  保存即提交到仓库,约 1 分钟后网站生效
                </span>
              </>
            ) : (
              <>
                <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-0.5 font-bold text-amber-500">
                  <HardDrive size={11} /> 本地模式
                </span>
                <span className="text-slate-500 dark:text-slate-400">
                  直接写本地文件(线上需配 GITHUB_TOKEN 才能提交)
                </span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-xl border border-white/30 px-3 py-2 text-xs font-bold text-slate-500 transition-colors hover:text-indigo-500 dark:border-white/10"
          >
            <ExternalLink size={13} /> 看网站
          </a>
          <button
            onClick={logout}
            className="flex items-center gap-1.5 rounded-xl border border-white/30 px-3 py-2 text-xs font-bold text-slate-500 transition-colors hover:text-rose-500 dark:border-white/10"
          >
            <LogOut size={13} /> 退出
          </button>
        </div>
      </header>

      {/* 标签页 */}
      <nav className="glass flex flex-wrap gap-2 rounded-2xl p-2">
        {[
          { key: "posts" as const, label: "文章", icon: FileText },
          { key: "moments" as const, label: "说说", icon: MessageCircle },
          { key: "data" as const, label: "数据(友链/项目/相册)", icon: Database },
        ].map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => {
              setTab(key);
              setDraft(null);
            }}
            className={`flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold transition-all ${
              tab === key
                ? "bg-aurora text-white shadow-lg"
                : "text-slate-600 hover:bg-white/40 dark:text-slate-300 dark:hover:bg-white/10"
            }`}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
      </nav>

      {error && (
        <p className="glass rounded-2xl border-rose-400/40 p-4 text-sm text-rose-500">
          {error}
        </p>
      )}

      {/* 编辑器 */}
      {draft && tab !== "data" && (
        <section className="glass rounded-3xl p-6">
          <div className="mb-5 flex items-center justify-between">
            <h2 className="font-black">
              {draft.slug ? "编辑" : "新建"}
              {tab === "posts" ? "文章" : "说说"}
            </h2>
            <button
              onClick={() => setDraft(null)}
              className="rounded-full p-1.5 text-slate-400 hover:bg-white/40 dark:hover:bg-white/10"
            >
              <X size={16} />
            </button>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-xs font-bold text-slate-500 dark:text-slate-400">
              标题
              <input
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                className="rounded-xl border border-white/30 bg-white/50 px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-indigo-400 dark:border-white/10 dark:bg-white/5 dark:text-slate-100"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-xs font-bold text-slate-500 dark:text-slate-400">
              日期
              <input
                type="date"
                value={draft.date}
                onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                className="rounded-xl border border-white/30 bg-white/50 px-3 py-2 text-sm font-normal outline-none focus:border-indigo-400 dark:border-white/10 dark:bg-white/5"
              />
            </label>
            {tab === "posts" && (
              <>
                <label className="flex flex-col gap-1.5 text-xs font-bold text-slate-500 dark:text-slate-400">
                  分类
                  <input
                    value={draft.category}
                    onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                    className="rounded-xl border border-white/30 bg-white/50 px-3 py-2 text-sm font-normal outline-none focus:border-indigo-400 dark:border-white/10 dark:bg-white/5"
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-xs font-bold text-slate-500 dark:text-slate-400">
                  标签(逗号分隔)
                  <input
                    value={draft.tags}
                    onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                    placeholder="Next.js, 随笔"
                    className="rounded-xl border border-white/30 bg-white/50 px-3 py-2 text-sm font-normal outline-none focus:border-indigo-400 dark:border-white/10 dark:bg-white/5"
                  />
                </label>
              </>
            )}
            <label className="flex flex-col gap-1.5 text-xs font-bold text-slate-500 sm:col-span-2 dark:text-slate-400">
              摘要
              <input
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                className="rounded-xl border border-white/30 bg-white/50 px-3 py-2 text-sm font-normal outline-none focus:border-indigo-400 dark:border-white/10 dark:bg-white/5"
              />
            </label>
            <div className="flex flex-col gap-1.5 text-xs font-bold text-slate-500 sm:col-span-2 dark:text-slate-400">
              封面图
              <div className="flex gap-2">
                <input
                  value={draft.cover}
                  onChange={(e) => setDraft({ ...draft, cover: e.target.value })}
                  placeholder="/uploads/xxx.jpg 或外链"
                  className="flex-1 rounded-xl border border-white/30 bg-white/50 px-3 py-2 text-sm font-normal outline-none focus:border-indigo-400 dark:border-white/10 dark:bg-white/5"
                />
                <label className="flex cursor-pointer items-center gap-1.5 rounded-xl border border-white/30 px-3 py-2 text-xs font-bold text-slate-500 hover:text-indigo-500 dark:border-white/10">
                  <Upload size={13} /> 上传
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadImage(f, (url) => setDraft({ ...draft, cover: url }));
                    }}
                  />
                </label>
              </div>
            </div>
            {tab === "posts" && (
              <label className="flex items-center gap-2 text-xs font-bold text-slate-500 dark:text-slate-400">
                <input
                  type="checkbox"
                  checked={draft.top}
                  onChange={(e) => setDraft({ ...draft, top: e.target.checked })}
                  className="h-4 w-4"
                />
                置顶这篇文章
              </label>
            )}
          </div>

          <label className="mt-4 flex flex-col gap-1.5 text-xs font-bold text-slate-500 dark:text-slate-400">
            正文(Markdown)
            <textarea
              value={draft.content}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
              rows={16}
              placeholder={"## 小标题\n\n正文支持 Markdown、代码块、表格……"}
              className="w-full rounded-xl border border-white/30 bg-white/50 px-3 py-2 font-mono text-sm font-normal leading-6 outline-none focus:border-indigo-400 dark:border-white/10 dark:bg-white/5"
            />
          </label>

          <div className="mt-5 flex gap-3">
            <button
              onClick={() => saveDraft(kind)}
              disabled={busy || !draft.title}
              className="bg-aurora flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold text-white disabled:opacity-60"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              保存
            </button>
            <button
              onClick={() => setDraft(null)}
              className="rounded-xl border border-white/30 px-5 py-2.5 text-sm font-bold text-slate-500 dark:border-white/10"
            >
              取消
            </button>
          </div>
        </section>
      )}

      {/* 数据编辑 */}
      {tab === "data" && (
        <section className="glass rounded-3xl p-6">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {["friends", "projects", "albums"].map((n) => (
              <button
                key={n}
                onClick={() => setDataName(n)}
                className={`rounded-xl px-3.5 py-2 text-xs font-bold transition-all ${
                  dataName === n
                    ? "bg-aurora text-white"
                    : "border border-white/30 text-slate-500 dark:border-white/10"
                }`}
              >
                {n === "friends" ? "友链" : n === "projects" ? "项目" : "相册"}
              </button>
            ))}
          </div>
          <textarea
            value={dataText}
            onChange={(e) => setDataText(e.target.value)}
            rows={18}
            spellCheck={false}
            className="w-full rounded-xl border border-white/30 bg-white/50 px-3 py-2 font-mono text-xs leading-6 outline-none focus:border-indigo-400 dark:border-white/10 dark:bg-white/5"
          />
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={saveData}
              disabled={busy}
              className="bg-aurora flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold text-white disabled:opacity-60"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              保存 JSON
            </button>
            <span className="text-xs text-slate-400">
              必须是合法 JSON;保存后约 1 分钟生效
            </span>
          </div>
        </section>
      )}

      {/* 列表 */}
      {tab !== "data" && (
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="font-black">
              {tab === "posts" ? `文章(${posts.length})` : `说说(${moments.length})`}
            </h2>
            <button
              onClick={() => void openEditor(kind)}
              className="bg-aurora flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-bold text-white"
            >
              <Plus size={14} /> 新建
            </button>
          </div>

          {list.length === 0 && (
            <p className="glass rounded-2xl p-6 text-center text-sm text-slate-400">
              还没有内容,点右上角「新建」
            </p>
          )}

          {list.map((item) => (
            <article
              key={item.slug}
              className="glass flex flex-wrap items-center justify-between gap-3 rounded-2xl p-4"
            >
              <div className="min-w-0">
                <p className="truncate font-bold">
                  {item.title || item.slug}
                  {item.top && (
                    <span className="ml-2 rounded-full bg-rose-500/90 px-2 py-0.5 text-[10px] text-white">
                      置顶
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {String(item.date || "").slice(0, 10)}
                  {item.category ? ` · ${item.category}` : ""}
                  {` · ${item.slug}`}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => void openEditor(kind, item.slug)}
                  className="flex items-center gap-1 rounded-xl border border-white/30 px-3 py-1.5 text-xs font-bold text-slate-500 transition-colors hover:text-indigo-500 dark:border-white/10"
                >
                  <Pencil size={12} /> 编辑
                </button>
                <button
                  onClick={() => void remove(kind, item.slug)}
                  className="flex items-center gap-1 rounded-xl border border-white/30 px-3 py-1.5 text-xs font-bold text-slate-500 transition-colors hover:text-rose-500 dark:border-white/10"
                >
                  <Trash2 size={12} /> 删除
                </button>
              </div>
            </article>
          ))}
        </section>
      )}

      {toast && (
        <div className="glass fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full px-5 py-2.5 text-sm font-bold text-indigo-500">
          {toast}
        </div>
      )}
    </div>
  );
}
