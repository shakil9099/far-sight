// Screen Score gauge: outer arc = session pacing (gold), inner arc = break discipline (pink),
// surrounded by a halo of dots. Returns an SVG element.
import type { StatsSummary } from "../shared/types";

const NS = "http://www.w3.org/2000/svg";
// Degrees clockwise from 12 o'clock: the arc runs from bottom-left (220°) over the top to
// bottom-right (500° = 140°), leaving an 80° gap centred at the bottom.
const START = 220;
const SWEEP = 280;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): string {
  const [x1, y1] = polar(cx, cy, r, fromDeg);
  const [x2, y2] = polar(cx, cy, r, toDeg);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

function path(d: string, attrs: Record<string, string>): SVGPathElement {
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", d);
  for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
  return p;
}

export function gauge(summary: Pick<StatsSummary, "score" | "parts">, size = 220): SVGSVGElement {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 220 200");
  s.setAttribute("width", String(size));
  s.setAttribute("height", String((size * 200) / 220));
  const cx = 110;
  const cy = 112;

  const defs = document.createElementNS(NS, "defs");
  defs.innerHTML = `
    <linearGradient id="g-gold" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#9c7410"/><stop offset="1" stop-color="#f2c94c"/></linearGradient>
    <linearGradient id="g-pink" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#b44bd9"/><stop offset="1" stop-color="#ff86ec"/></linearGradient>`;
  s.append(defs);

  // halo dots
  for (let ring = 0; ring < 3; ring++) {
    const r = 100 + ring * 7;
    const count = 34 + ring * 6;
    for (let i = 0; i <= count; i++) {
      const deg = START + (SWEEP * i) / count;
      const [x, y] = polar(cx, cy, r, deg);
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", String(x));
      c.setAttribute("cy", String(y));
      c.setAttribute("r", String(1.6 - ring * 0.35));
      c.setAttribute("fill", `rgba(255,255,255,${0.16 - ring * 0.045})`);
      s.append(c);
    }
  }

  const pacing = summary.parts?.pacing ?? 0;
  const discipline = summary.parts?.discipline ?? 0;
  const track = { fill: "none", stroke: "rgba(255,255,255,0.1)", "stroke-width": "14", "stroke-linecap": "round" };
  s.append(path(arcPath(cx, cy, 86, START, START + SWEEP), track));
  s.append(path(arcPath(cx, cy, 64, START, START + SWEEP), { ...track, "stroke-width": "12" }));
  if (pacing > 0.005)
    s.append(path(arcPath(cx, cy, 86, START, START + SWEEP * pacing), { ...track, stroke: "url(#g-gold)" }));
  if (discipline > 0.005)
    s.append(path(arcPath(cx, cy, 64, START, START + SWEEP * discipline), { ...track, "stroke-width": "12", stroke: "url(#g-pink)" }));

  const t = document.createElementNS(NS, "text");
  t.setAttribute("x", String(cx));
  t.setAttribute("y", String(cy + 14));
  t.setAttribute("text-anchor", "middle");
  t.setAttribute("class", "num");
  t.setAttribute("font-size", summary.score == null ? "34" : "44");
  t.setAttribute("fill", "#fff");
  t.textContent = summary.score == null ? "—" : String(summary.score);
  s.append(t);
  return s;
}
