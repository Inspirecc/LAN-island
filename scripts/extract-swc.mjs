// scripts/extract-swc.mjs — 解压 swc tgz 到 node_modules(零依赖 tar.gz 解析)
import fs from "fs";
import path from "path";
import zlib from "zlib";

const TGZ = path.resolve("swc-pkg.tgz");
const DEST = path.resolve("node_modules", "@next", "swc-win32-x64-msvc");

// ---- 极简 ustar 解析(足够处理 npm 打包的普通文件/目录/长名) ----
function parseTar(buf) {
  const entries = [];
  let off = 0;
  let longName = null;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim() || "0", 8);
    const type = String.fromCharCode(header[156]);
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    off += 512;
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;

    if (type === "L") {
      // GNU long name
      longName = data.toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    let fullName = longName || (prefix ? `${prefix}/${name}` : name);
    longName = null;
    if (type === "x" || type === "g") continue; // pax header,忽略(路径均 <100 不需要)
    entries.push({ name: fullName, type, data });
  }
  return entries;
}

const raw = fs.readFileSync(TGZ);
const buf = zlib.gunzipSync(raw);
const entries = parseTar(buf);

fs.mkdirSync(DEST, { recursive: true });
let files = 0;
for (const e of entries) {
  // 去掉包前缀 package/
  const rel = e.name.replace(/^package\/?/, "");
  if (!rel) continue;
  const target = path.join(DEST, rel);
  if (e.type === "5" || e.type === "0" || e.type === "\0" || e.type === "") {
    if (e.type === "5" || e.name.endsWith("/")) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.data);
      files++;
    }
  }
}
console.log(`extracted ${files} files to ${DEST}`);
console.log("binary exists:", fs.existsSync(path.join(DEST, "next-swc.win32-x64-msvc.node")));
