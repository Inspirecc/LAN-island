// scripts/check-lockfile.mjs — 离线校验 pnpm-lock 与 package.json 的 specifier 是否一致
import fs from "fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = fs.readFileSync("pnpm-lock.yaml", "utf8");

// 取 importers 段中 "." 下的依赖声明
const importerStart = lock.indexOf("importers:");
const depStart = lock.indexOf("dependencies:", importerStart);
const devStart = lock.indexOf("devDependencies:", depStart);
const optStart = lock.indexOf("optionalDependencies:", devStart);
const block = lock.slice(depStart, optStart > 0 ? optStart : lock.length);

// 解析 "name:\n  specifier: xxx"(@scope 包名带引号,需去掉)
const lockSpecs = {};
const re = /^\s{6}([^\s:]+):\s*\n\s+specifier:\s*(.+)$/gm;
let m;
while ((m = re.exec(block))) {
  const key = m[1].replace(/^['"]|['"]$/g, "");
  lockSpecs[key] = m[2].trim();
}

const problems = [];
for (const [name, range] of Object.entries(pkg.dependencies || {})) {
  if (!(name in lockSpecs)) problems.push(`依赖缺失于锁文件: ${name}`);
  else if (lockSpecs[name] !== range)
    problems.push(`${name}: package.json=${range} 锁文件=${lockSpecs[name]}`);
}
for (const [name, range] of Object.entries(pkg.devDependencies || {})) {
  if (!(name in lockSpecs)) problems.push(`开发依赖缺失于锁文件: ${name}`);
  else if (lockSpecs[name] !== range)
    problems.push(`${name}: package.json=${range} 锁文件=${lockSpecs[name]}`);
}
// 锁文件里多出来的(已删除的包)
for (const name of Object.keys(lockSpecs)) {
  if (!pkg.dependencies?.[name] && !pkg.devDependencies?.[name])
    problems.push(`锁文件多余项(manifest 已删): ${name} @ ${lockSpecs[name]}`);
}

if (problems.length === 0) {
  console.log("✅ 锁文件与 package.json 完全一致,Vercel frozen-lockfile 可通过");
} else {
  console.log("❌ 发现不一致:");
  problems.forEach((p) => console.log("  -", p));
  process.exit(1);
}
