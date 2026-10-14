// scripts/validate-posts.mjs — 用站点自身的 gray-matter 校验所有文章 front-matter
import fs from "fs";
import path from "path";
import matter from "gray-matter";

const dir = path.join(process.cwd(), "posts");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));

const allowedCats = new Set([
  "并发编程", "数据库", "Redis", "微服务", "消息队列",
  "Elasticsearch", "AI 与大模型", "计算机基础", "高并发", "随笔", "技术", "测试",
]);

const problems = [];
const rows = [];

for (const f of files) {
  const raw = fs.readFileSync(path.join(dir, f), "utf8");
  // 检查 BOM
  if (raw.charCodeAt(0) === 0xfeff) problems.push(`${f}: 文件带 BOM`);
  // 检查 CRLF
  if (raw.includes("\r\n")) problems.push(`${f}: 含 CRLF 换行`);
  // 检查 front-matter 必须从第一行开始
  if (!raw.startsWith("---")) problems.push(`${f}: 首行不是 ---`);

  let data;
  try {
    ({ data } = matter(raw));
  } catch (e) {
    problems.push(`${f}: gray-matter 解析失败 - ${e.message}`);
    continue;
  }

  for (const key of ["title", "date", "description", "tags", "category"]) {
    if (!data[key]) problems.push(`${f}: 缺少 ${key}`);
  }
  if (data.date && !(data.date instanceof Date) && !/^\d{4}-\d{2}-\d{2}/.test(String(data.date))) {
    problems.push(`${f}: date 格式异常 -> ${data.date}`);
  }
  if (data.tags && !Array.isArray(data.tags)) problems.push(`${f}: tags 不是数组`);
  if (data.category && !allowedCats.has(data.category)) {
    problems.push(`${f}: 未知分类 "${data.category}"`);
  }

  rows.push({
    file: f,
    date: data.date instanceof Date ? data.date.toISOString().slice(0, 10) : String(data.date || ""),
    category: data.category || "",
    title: data.title || "",
    words: raw.length,
  });
}

rows.sort((a, b) => a.date.localeCompare(b.date));

console.log("=== 文章清单(按日期) ===");
for (const r of rows) {
  console.log(`${r.date}  [${r.category}]  ${r.title}   (${r.file})`);
}
console.log(`\n共 ${rows.length} 篇`);

// 分类统计
const catCount = {};
for (const r of rows) catCount[r.category] = (catCount[r.category] || 0) + 1;
console.log("\n=== 分类分布 ===");
for (const [k, v] of Object.entries(catCount).sort((a, b) => b[1] - a[1])) {
  console.log(`${k}: ${v}`);
}

// 同一天重复检查
const byDate = {};
for (const r of rows) (byDate[r.date] = byDate[r.date] || []).push(r.title);
const dupes = Object.entries(byDate).filter(([, v]) => v.length > 1);
if (dupes.length) {
  console.log("\n=== 日期重复 ===");
  for (const [d, titles] of dupes) console.log(`${d}: ${titles.join(" | ")}`);
}

if (problems.length) {
  console.log("\n=== ❌ 问题 ===");
  problems.forEach((p) => console.log("  -", p));
  process.exit(1);
} else {
  console.log("\n✅ 全部 front-matter 合法");
}
