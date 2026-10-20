"use client";

// components/MusicPlayer.tsx — 悬浮音乐播放器(右下角,毛玻璃风格)
// 功能:播放/暂停、上一首/下一首、进度条、音量、自动切歌、状态记忆(localStorage)
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Disc3,
  Music2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { siteConfig } from "@/siteConfig";

const { enabled, defaultVolume, playlist } = siteConfig.music;
// 解除 as const 的字面量类型,让音量/索引可以自由赋值
const initialVolume: number = defaultVolume;
const songCount: number = playlist.length;

const LS_KEY = "li_music_state";

export default function MusicPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [open, setOpen] = useState(false);          // 面板展开
  const [showFab, setShowFab] = useState(enabled);  // 悬浮球显示
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState<number>(0);      // 0~100
  const [duration, setDuration] = useState<number>(0);
  const [cur, setCur] = useState<number>(0);
  const [volume, setVolume] = useState<number>(initialVolume);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState(false);

  const track = playlist[index];

  // 恢复上次的曲目与音量
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || "{}") as {
        index?: number;
        volume?: number;
      };
      if (typeof saved.index === "number" && saved.index < songCount) {
        setIndex(saved.index);
      }
      if (typeof saved.volume === "number") setVolume(saved.volume);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 持久化
  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify({ index, volume }));
  }, [index, volume]);

  // 音量同步
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = muted ? 0 : volume;
    }
  }, [volume, muted]);

  // 切歌时:如果在播放中,自动续播
  const changeTrack = useCallback(
    (next: number, autoplay = true) => {
      setIndex(next);
      setProgress(0);
      setCur(0);
      setError(false);
      // 等 src 更新后再播放
      requestAnimationFrame(() => {
        const a = audioRef.current;
        if (a && autoplay) {
          a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
        }
      });
    },
    []
  );

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) {
      a.pause();
      setPlaying(false);
    } else {
      a.play().then(() => setPlaying(true)).catch(() => setError(true));
    }
  };

  const fmt = (sec: number) => {
    if (!Number.isFinite(sec)) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  if (!enabled || songCount === 0 || !showFab) return null;

  return (
    <>
      {/* 悬浮球 */}
      <button
        aria-label="音乐播放器"
        onClick={() => setOpen(true)}
        className="glass fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full transition-all duration-300 hover:scale-110"
      >
        <Disc3
          size={26}
          className={`text-indigo-400 ${playing ? "animate-spin [animation-duration:3s]" : ""}`}
        />
        {playing && (
          <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-aurora">
            <Music2 size={9} className="text-white" />
          </span>
        )}
      </button>

      {/* 播放面板 */}
      {open && (
        <div className="fixed bottom-6 right-6 z-50 w-80">
          <div className="glass rounded-3xl p-5 shadow-2xl">
            {/* 头部 */}
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-black">
                <Disc3
                  size={18}
                  className={`text-indigo-400 ${playing ? "animate-spin [animation-duration:3s]" : ""}`}
                />
                正在播放
              </div>
              <button
                aria-label="收起"
                onClick={() => setOpen(false)}
                className="rounded-full p-1.5 text-slate-400 transition-colors hover:bg-white/40 dark:hover:bg-white/10"
              >
                <X size={15} />
              </button>
            </div>

            {/* 曲目信息 */}
            <div className="mb-3">
              <p className="truncate text-base font-black">{track?.title}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {track?.artist}
              </p>
            </div>

            {/* 进度条 */}
            <div className="mb-1">
              <input
                type="range"
                min={0}
                max={100}
                value={progress}
                onChange={(e) => {
                  const a = audioRef.current;
                  if (a && duration) {
                    const sec = (Number(e.target.value) / 100) * duration;
                    a.currentTime = sec;
                    setProgress(Number(e.target.value));
                  }
                }}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-400/30 accent-indigo-500"
              />
              <div className="mt-1 flex justify-between text-[10px] text-slate-400">
                <span>{fmt(cur)}</span>
                <span>{fmt(duration)}</span>
              </div>
            </div>

            {/* 控制按钮 */}
            <div className="mb-3 flex items-center justify-center gap-4">
              <button
                aria-label="上一首"
                onClick={() => changeTrack((index - 1 + songCount) % songCount, playing)}
                className="rounded-full p-2 text-slate-500 transition-colors hover:bg-white/40 hover:text-indigo-500 dark:text-slate-400 dark:hover:bg-white/10"
              >
                <SkipBack size={18} />
              </button>
              <button
                aria-label={playing ? "暂停" : "播放"}
                onClick={togglePlay}
                className="bg-aurora flex h-11 w-11 items-center justify-center rounded-full text-white shadow-lg transition-transform hover:scale-105"
              >
                {playing ? <Pause size={20} /> : <Play size={20} className="ml-0.5" />}
              </button>
              <button
                aria-label="下一首"
                onClick={() => changeTrack((index + 1) % songCount, playing)}
                className="rounded-full p-2 text-slate-500 transition-colors hover:bg-white/40 hover:text-indigo-500 dark:text-slate-400 dark:hover:bg-white/10"
              >
                <SkipForward size={18} />
              </button>
            </div>

            {/* 音量 */}
            <div className="flex items-center gap-2">
              <button
                aria-label="静音"
                onClick={() => setMuted(!muted)}
                className="text-slate-400 transition-colors hover:text-indigo-500"
              >
                {muted || volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
              </button>
              <input
                type="range"
                min={0}
                max={100}
                value={muted ? 0 : Math.round(volume * 100)}
                onChange={(e) => {
                  setVolume(Number(e.target.value) / 100);
                  setMuted(false);
                }}
                className="h-1 w-full cursor-pointer appearance-none rounded-full bg-slate-400/30 accent-indigo-500"
              />
            </div>

            {/* 错误提示 */}
            {error && (
              <p className="mt-3 text-xs text-rose-400">
                播放失败,可能是音源链接失效,换一首试试
              </p>
            )}

            {/* 歌单 */}
            {songCount > 1 && (
              <div className="mt-4 max-h-32 overflow-auto border-t border-white/20 pt-3 dark:border-white/10">
                {playlist.map((t, i) => (
                  <button
                    key={t.url}
                    onClick={() => changeTrack(i, playing)}
                    className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                      i === index
                        ? "bg-indigo-500/10 font-bold text-indigo-500"
                        : "text-slate-500 hover:bg-white/40 dark:text-slate-400 dark:hover:bg-white/10"
                    }`}
                  >
                    <span className="truncate">{t.title}</span>
                    <span className="ml-2 shrink-0 opacity-60">{t.artist}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 音频元素:换 src 即换歌 */}
      <audio
        ref={audioRef}
        src={track?.url}
        preload="none"
        onTimeUpdate={(e) => {
          const a = e.currentTarget;
          if (a.duration) {
            setCur(a.currentTime);
            setProgress((a.currentTime / a.duration) * 100);
          }
        }}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onEnded={() => changeTrack((index + 1) % songCount, true)}
        onError={() => setError(true)}
      />
    </>
  );
}
