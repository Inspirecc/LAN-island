// lib/admin-auth.ts — 后台登录鉴权(密码 + HMAC 签名 cookie)
import crypto from "crypto";
import { cookies } from "next/headers";

export const ADMIN_COOKIE = "li_admin";
const MAX_AGE_MS = 7 * 864e5; // 7 天

/** 没配 ADMIN_PASSWORD 时后台整体禁用 */
export function adminEnabled(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD);
}

function secret(): string {
  return (
    process.env.ADMIN_COOKIE_SECRET ||
    process.env.ADMIN_PASSWORD ||
    "lan-island-dev-secret"
  );
}

function sign(value: string): string {
  return crypto.createHmac("sha256", secret()).update(value).digest("hex");
}

export function makeToken(): string {
  const payload = String(Date.now() + MAX_AGE_MS);
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token?: string): boolean {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expect = sign(payload);
  if (sig.length !== expect.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  return Number(payload) > Date.now();
}

export function checkPassword(input?: string): boolean {
  const real = process.env.ADMIN_PASSWORD;
  if (!real || !input) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(real);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 在 API 路由里校验登录态 */
export async function isAuthed(): Promise<boolean> {
  const store = await cookies();
  return verifyToken(store.get(ADMIN_COOKIE)?.value);
}
