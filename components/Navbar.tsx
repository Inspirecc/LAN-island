"use client";

// components/Navbar.tsx — 毛玻璃导航栏:滚动隐藏、主题切换、移动端抽屉
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu, Moon, Sun, X } from "lucide-react";
import { useTheme } from "next-themes";
import { siteConfig } from "@/siteConfig";

const navLinks = [
  { name: "首页", href: "/" },
  { name: "文章", href: "/posts" },
  { name: "说说", href: "/moments" },
  { name: "相册", href: "/photowall" },
  { name: "项目", href: "/projects" },
  { name: "归档", href: "/archive" },
  { name: "友链", href: "/friends" },
  { name: "关于", href: "/about" },
];

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted)
    return <div className="h-9 w-9 rounded-full" />;
  return (
    <button
      aria-label="切换主题"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      className="flex h-9 w-9 items-center justify-center rounded-full text-slate-600 transition-colors hover:bg-white/40 hover:text-indigo-500 dark:text-slate-300 dark:hover:bg-white/10"
    >
      {resolvedTheme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

export default function Navbar() {
  const [show, setShow] = useState(true);
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    let last = window.scrollY;
    const onScroll = () => {
      const cur = window.scrollY;
      setShow(cur < last || cur < 80);
      last = cur;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => setOpen(false), [pathname]);

  return (
    <>
      <header
        className={`fixed inset-x-0 top-0 z-50 border-b border-white/20 bg-white/40 backdrop-blur-xl transition-transform duration-500 dark:border-white/5 dark:bg-slate-900/50 ${
          show ? "translate-y-0" : "-translate-y-full"
        }`}
      >
        <div className="mx-auto flex h-16 w-[92%] max-w-6xl items-center justify-between">
          <Link
            href="/"
            className="text-lg font-black tracking-tight transition-colors hover:opacity-80"
          >
            <span className="text-aurora">{siteConfig.navTitle}</span>
          </Link>

          <nav className="hidden items-center gap-7 text-sm font-bold md:flex">
            {navLinks.map((l) => {
              const active =
                l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`relative py-1 transition-colors ${
                    active
                      ? "text-indigo-500 dark:text-indigo-400"
                      : "text-slate-600 hover:text-indigo-500 dark:text-slate-300"
                  }`}
                >
                  {l.name}
                  {active && (
                    <span className="absolute -bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 animate-pulse rounded-full bg-indigo-500" />
                  )}
                </Link>
              );
            })}
          </nav>

          <div className="flex items-center gap-1">
            <ThemeToggle />
            <button
              aria-label="菜单"
              onClick={() => setOpen(!open)}
              className="flex h-9 w-9 items-center justify-center rounded-full text-slate-600 transition-colors hover:bg-white/40 dark:text-slate-300 md:hidden"
            >
              {open ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>
      </header>

      {/* 移动端抽屉 */}
      <div
        className={`fixed inset-0 z-40 bg-black/30 backdrop-blur-sm transition-opacity duration-300 md:hidden ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setOpen(false)}
      >
        <nav
          className={`glass absolute right-4 top-20 flex w-48 flex-col gap-1 rounded-2xl p-4 ${
            open ? "translate-y-0 opacity-100" : "-translate-y-4 opacity-0"
          } transition-all duration-300`}
          onClick={(e) => e.stopPropagation()}
        >
          {navLinks.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded-xl px-4 py-2.5 text-sm font-bold transition-colors ${
                (l.href === "/" ? pathname === "/" : pathname.startsWith(l.href))
                  ? "bg-indigo-500/10 text-indigo-500"
                  : "hover:bg-white/40 dark:hover:bg-white/10"
              }`}
            >
              {l.name}
            </Link>
          ))}
        </nav>
      </div>
    </>
  );
}
