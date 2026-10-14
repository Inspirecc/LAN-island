// components/AuroraBackground.tsx — 固定的极光渐变光斑(服务端组件,零 JS)
import type { CSSProperties } from "react";

const blobs: CSSProperties[] = [
  {
    top: "-10%",
    left: "-5%",
    width: "45vw",
    height: "45vw",
    background: "#24c6dc",
    animation: "drift 26s ease-in-out infinite",
  },
  {
    top: "20%",
    right: "-10%",
    width: "40vw",
    height: "40vw",
    background: "#5433ff",
    animation: "drift 32s ease-in-out infinite reverse",
  },
  {
    bottom: "-15%",
    left: "20%",
    width: "50vw",
    height: "50vw",
    background: "#ff0099",
    animation: "drift 38s ease-in-out infinite",
  },
];

export default function AuroraBackground() {
  return (
    <div aria-hidden className="fixed inset-0 overflow-hidden">
      {blobs.map((style, i) => (
        <div key={i} className="aurora-blob" style={style} />
      ))}
    </div>
  );
}
