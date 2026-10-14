// app/photowall/[id]/page.tsx — 单本相册(服务端组件 + 客户端灯箱)
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAlbum, getAlbums } from "@/lib/data";
import PhotoGrid from "@/components/PhotoGrid";
import BackButton from "@/components/BackButton";

export function generateStaticParams() {
  return getAlbums().map((a) => ({ id: a.id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const album = getAlbum(id);
  return { title: album ? album.title : "相册" };
}

export default async function AlbumPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const album = getAlbum(id);
  if (!album) notFound();

  return (
    <div className="flex flex-col gap-6 pb-10">
      <BackButton />
      <header>
        <h1 className="text-2xl font-black">{album.title}</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {album.description} · {album.photos.length} 张
        </p>
      </header>
      <PhotoGrid photos={album.photos} />
      <Link
        href="/photowall"
        className="w-fit text-sm font-bold text-slate-500 transition-colors hover:text-indigo-500 dark:text-slate-400"
      >
        ← 全部相册
      </Link>
    </div>
  );
}
