// app/api/admin/[[...action]]/route.ts — 后台 API 入口
import type { NextRequest } from "next/server";
import { handleAdmin } from "@/lib/admin-api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ action?: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return handleAdmin(req, ctx);
}
export async function POST(req: NextRequest, ctx: Ctx) {
  return handleAdmin(req, ctx);
}
export async function PUT(req: NextRequest, ctx: Ctx) {
  return handleAdmin(req, ctx);
}
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return handleAdmin(req, ctx);
}
