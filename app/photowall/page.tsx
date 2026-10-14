// app/photowall/page.tsx — 照片墙:相册封面网格 + 点进相册
import Image from "next/image";
import Link from "next/link";
import { Camera } from "lucide-react";
import { getAlbums } from "@/lib/data";

export const metadata = { title: "照片墙" };

export default function PhotowallPage() {
  const albums = getAlbums();

  return (
    <div className="flex flex-col gap-6 pb-10">
      <header className="flex items-center gap-3">
        <Camera className="text-indigo-500" size={26} />
        <div>
          <h1 className="text-2xl font-black">照片墙</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {albums.length} 本相册 · 岛上的光影备忘录
          </p>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {albums.map((album) => (
          <Link
            key={album.id}
            href={`/photowall/${album.id}`}
            className="glass group relative h-56 overflow-hidden rounded-3xl"
          >
            <Image
              src={album.cover}
              alt={album.title}
              width={800}
              height={600}
              className="absolute inset-0 h-full w-full object-cover opacity-90 transition-transform duration-700 group-hover:scale-105"
            />
            <div className="absolute inset-0 bg-black/30 transition-colors duration-500 group-hover:bg-black/10" />
            <div className="absolute bottom-5 left-5 right-5">
              <h2 className="text-xl font-black text-white underline decoration-pink-400 underline-offset-4">
                {album.title}
              </h2>
              <p className="mt-1 text-sm text-white/85">{album.description}</p>
              <p className="text-xs text-white/60">{album.photos.length} 张</p>
            </div>
          </Link>
        ))}
      </div>
      {albums.length === 0 && (
        <p className="glass rounded-3xl p-10 text-center text-sm text-slate-400">
          还没有相册,去后台「数据」页添加一本
        </p>
      )}
    </div>
  );
}
