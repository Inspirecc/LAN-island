// scripts/verify-live.mjs — 绕过 DNS 污染验证线上站点
// 用 Cloudflare DoH 取真实 IP,再用该 IP + SNI 直连请求。
import https from "https";
import dns from "dns";

const HOST = process.argv[2] || "lan-island.vercel.app";

function resolveViaDoH(name) {
  return new Promise((resolve, reject) => {
    https
      .get(
        `https://1.1.1.1/dns-query?name=${encodeURIComponent(name)}&type=A`,
        { headers: { accept: "application/dns-json" }, servername: "cloudflare-dns.com" },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              const json = JSON.parse(body);
              const ips = (json.Answer || [])
                .filter((a) => a.type === 1)
                .map((a) => a.data);
              resolve(ips);
            } catch (e) {
              reject(e);
            }
          });
        }
      )
      .on("error", reject);
  });
}

function get(path, ip) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: ip,
        servername: HOST,
        path,
        method: "GET",
        headers: { Host: HOST, "User-Agent": "verify-script" },
        timeout: 30000,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
      }
    );
    req.on("error", (e) => resolve({ status: 0, error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, error: "timeout" }); });
    req.end();
  });
}

const ips = await resolveViaDoH(HOST).catch(() => []);
console.log("DoH 解析结果:", ips.length ? ips.join(", ") : "(失败)");
const candidates = ips.length ? ips : ["76.76.21.21"];

for (const path of ["/", "/admin", "/api/admin/session", "/posts", "/moments"]) {
  let done = false;
  for (const ip of candidates) {
    const r = await get(path, ip);
    if (r.status) {
      const marks = [];
      if (/LAN ISLAND/.test(r.body)) marks.push("标题✓");
      if (path === "/admin" && /后台/.test(r.body)) marks.push("后台页✓");
      if (path.includes("session") && r.status === 401) marks.push("鉴权生效✓");
      if (/latest|最新文章/.test(r.body)) marks.push("文章✓");
      console.log(`${path} -> ${r.status} ${r.body.length}B ${marks.join(" ")}  [ip ${ip}]`);
      done = true;
      break;
    }
  }
  if (!done) console.log(`${path} -> 全部 IP 均失败`);
}
