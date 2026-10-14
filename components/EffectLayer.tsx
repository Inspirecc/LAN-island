"use client";

// components/EffectLayer.tsx — 可开关的粒子特效层(樱花/萤火虫,默认关)
// 纯 CSS 动画实现,数量少、GPU 友好。
import { useMemo } from "react";
import { siteConfig } from "@/siteConfig";

interface Particle {
  left: string;
  delay: string;
  duration: string;
  size: number;
  drift: string;
}

function makeParticles(count: number): Particle[] {
  return Array.from({ length: count }, () => ({
    left: `${Math.random() * 100}%`,
    delay: `${Math.random() * 20}s`,
    duration: `${14 + Math.random() * 16}s`,
    size: 6 + Math.random() * 8,
    drift: `${(Math.random() - 0.5) * 160}px`,
  }));
}

export default function EffectLayer() {
  const { sakura, fireflies } = siteConfig.effects;
  const sakuraParticles = useMemo(
    () => (sakura ? makeParticles(14) : []),
    [sakura]
  );
  const fireflyParticles = useMemo(
    () => (fireflies ? makeParticles(10) : []),
    [fireflies]
  );

  if (!sakura && !fireflies) return null;

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[5] overflow-hidden">
      {sakuraParticles.map((p, i) => (
        <span
          key={`s-${i}`}
          className="absolute -top-8 text-pink-400/70"
          style={{
            left: p.left,
            fontSize: p.size,
            animation: `sakura-fall ${p.duration} linear ${p.delay} infinite`,
            ["--drift" as string]: p.drift,
          }}
        >
          ❀
        </span>
      ))}
      {fireflyParticles.map((p, i) => (
        <span
          key={`f-${i}`}
          className="absolute h-1.5 w-1.5 rounded-full bg-amber-300 shadow-[0_0_8px_2px_rgba(252,211,77,0.8)]"
          style={{
            left: p.left,
            top: `${20 + Math.random() * 70}%`,
            animation: `firefly ${p.duration} ease-in-out ${p.delay} infinite`,
          }}
        />
      ))}
    </div>
  );
}
