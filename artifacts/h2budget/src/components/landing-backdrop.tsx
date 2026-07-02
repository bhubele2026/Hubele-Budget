/**
 * The landing page's full-page background: a dense flowing wire-mesh ribbon
 * (many fine phase-shifted curves) + a faint constellation, in cool blue-grey,
 * brightest across the top and fading down the page. Hand-authored SVG so it
 * scales crisply and fills the dead space with detail — the "background image"
 * look from the mockup, no raster asset.
 *
 * Purely decorative: absolutely positioned, pointer-events-none, behind content.
 */

// One flowing curve as a cubic-bézier path across the full width, following a
// multi-frequency base wave offset vertically by `offset`.
function wavePath(offset: number, amp: number, phase: number): string {
  const W = 1440;
  const steps = 6;
  const seg = W / steps;
  const yAt = (x: number) =>
    offset +
    Math.sin((x / W) * Math.PI * 2 + phase) * amp +
    Math.sin((x / W) * Math.PI * 4 + phase * 1.7) * amp * 0.35;
  let d = `M0,${yAt(0).toFixed(1)}`;
  for (let i = 0; i < steps; i++) {
    const x0 = i * seg;
    const x1 = (i + 1) * seg;
    const cx = x0 + seg / 2;
    d += ` C${cx.toFixed(1)},${yAt(x0).toFixed(1)} ${cx.toFixed(1)},${yAt(x1).toFixed(1)} ${x1.toFixed(1)},${yAt(x1).toFixed(1)}`;
  }
  return d;
}

export function LandingBackdrop() {
  // A woven ribbon of ~46 parallel curves near the top, thinning as they fall.
  const ribbon = Array.from({ length: 46 }, (_, i) => {
    const t = i / 45;
    return {
      d: wavePath(120 + i * 6.5, 34 - t * 10, t * Math.PI * 1.4),
      opacity: 0.10 + (1 - t) * 0.5,
      width: i % 5 === 0 ? 1.1 : 0.6,
    };
  });

  // Constellation nodes scattered across the page + a few connecting edges.
  const nodes: [number, number][] = [
    [90, 90], [260, 60], [520, 130], [900, 70], [1180, 120], [1330, 60],
    [140, 520], [70, 780], [360, 690], [1240, 560], [1360, 760], [1080, 840],
    [640, 900], [420, 980], [1180, 980], [80, 1020],
  ];
  const edges: [number, number][] = [
    [0, 1], [1, 2], [3, 4], [4, 5], [6, 7], [6, 8], [9, 10], [10, 11],
    [12, 13], [9, 11], [3, 2], [8, 12],
  ];

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden bg-gradient-to-b from-[hsl(210_45%_96%)] via-[hsl(210_40%_97%)] to-background dark:from-[hsl(210_30%_10%)] dark:via-[hsl(215_28%_9%)] dark:to-background"
    >
      <svg
        viewBox="0 0 1440 1100"
        preserveAspectRatio="xMidYMin slice"
        className="absolute inset-0 h-full w-full"
      >
        <defs>
          <linearGradient id="mesh-stroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="hsl(205 55% 62%)" />
            <stop offset="50%" stopColor="hsl(215 45% 58%)" />
            <stop offset="100%" stopColor="hsl(225 40% 62%)" />
          </linearGradient>
          <linearGradient id="mesh-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="white" stopOpacity="1" />
            <stop offset="45%" stopColor="white" stopOpacity="0.5" />
            <stop offset="100%" stopColor="white" stopOpacity="0.08" />
          </linearGradient>
          <mask id="mesh-mask">
            <rect x="0" y="0" width="1440" height="1100" fill="url(#mesh-fade)" />
          </mask>
        </defs>

        <g mask="url(#mesh-mask)" stroke="url(#mesh-stroke)" fill="none">
          {ribbon.map((w, i) => (
            <path key={i} d={w.d} strokeWidth={w.width} opacity={w.opacity} />
          ))}
        </g>

        <g stroke="hsl(215 40% 60%)" opacity="0.18">
          {edges.map(([a, b], i) => (
            <line
              key={i}
              x1={nodes[a][0]}
              y1={nodes[a][1]}
              x2={nodes[b][0]}
              y2={nodes[b][1]}
              strokeWidth="0.8"
            />
          ))}
        </g>
        <g fill="hsl(215 45% 58%)">
          {nodes.map(([cx, cy], i) => (
            <circle key={i} cx={cx} cy={cy} r={i % 3 === 0 ? 3 : 1.8} opacity={0.28} />
          ))}
        </g>
      </svg>
    </div>
  );
}
