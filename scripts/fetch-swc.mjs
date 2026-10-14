// scripts/fetch-swc.mjs — 手动拉取 @next/swc-win32-x64-msvc 二进制(pnpm 安装失败时的兜底)
import https from "https";
import fs from "fs";
import path from "path";

const OUT = path.resolve("swc-pkg.tgz");
const urls = process.argv[2]
  ? [process.argv[2]]
  : [
      "https://registry.npmjs.org/@next/swc-win32-x64-msvc/-/swc-win32-x64-msvc-16.2.1.tgz",
      "https://registry.npmmirror.com/@next/swc-win32-x64-msvc/-/swc-win32-x64-msvc-16.2.1.tgz",
    ];

function dl(i) {
  if (i >= urls.length) {
    console.log("ALL FAILED");
    process.exit(1);
  }
  const u = urls[i];
  console.log("GET", u);
  const req = https.get(u, { headers: { "User-Agent": "node" } }, (res) => {
    if (res.statusCode !== 200) {
      console.log("HTTP", res.statusCode);
      res.resume();
      return dl(i + 1);
    }
    const f = fs.createWriteStream(OUT);
    res.pipe(f);
    f.on("finish", () => {
      f.close(() => {
        console.log("SIZE", fs.statSync(OUT).size);
        process.exit(0);
      });
    });
  });
  req.on("error", (e) => {
    console.log("ERR", e.message);
    dl(i + 1);
  });
}

dl(0);
