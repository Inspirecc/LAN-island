// app/admin/page.tsx — 后台入口(服务端壳,内容交给客户端组件)
import type { Metadata } from "next";
import AdminApp from "./AdminApp";

export const metadata: Metadata = {
  title: "后台管理",
  robots: { index: false, follow: false },
};

// 后台依赖 cookie 鉴权,不做静态生成
export const dynamic = "force-dynamic";

export default function AdminPage() {
  return <AdminApp />;
}
