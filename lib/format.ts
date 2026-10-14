// lib/format.ts — 纯格式化函数(客户端/服务端通用)
export function formatDate(iso: string): string {
  const d = new Date(iso);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function daysSince(dateStr: string): number {
  return Math.max(
    1,
    Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000)
  );
}
