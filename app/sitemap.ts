import type { MetadataRoute } from "next";
import { getAllPosts } from "@/lib/posts";
import { siteConfig } from "@/siteConfig";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteConfig.siteUrl;
  const staticPages = ["", "/posts", "/moments", "/photowall", "/projects", "/archive", "/tags", "/friends", "/about", "/message"].map(
    (p) => ({ url: `${base}${p}`, lastModified: new Date() })
  );
  const postPages = getAllPosts().map((p) => ({
    url: `${base}/posts/${p.slug}`,
    lastModified: new Date(p.date),
  }));
  return [...staticPages, ...postPages];
}
