// Blink & posture reminder overlay. Click-through; closes itself after `duration` seconds.
import { param } from "./api";

const kind = param<string>("kind") === "posture" ? "posture" : "blink";
const size = param<string>("size") ?? "medium";
const position = param<string>("position") ?? "center";
const duration = Math.max(2, Number(param<number>("duration") ?? 5));
const dim = param<boolean>("dim") === true;

// Blink: an almond eye that opens, blinks, glances around and sparkles.
const EYE = `
<svg class="eye" viewBox="0 0 100 100" aria-hidden="true">
  <defs>
    <radialGradient id="iris" cx="45%" cy="40%" r="60%">
      <stop offset="0" stop-color="#9fe3ff"/>
      <stop offset="0.55" stop-color="#5ac8fa"/>
      <stop offset="1" stop-color="#2f56d8"/>
    </radialGradient>
    <clipPath id="almond"><path d="M8 50 Q50 12 92 50 Q50 88 8 50 Z"/></clipPath>
  </defs>
  <g class="lid">
    <path d="M8 50 Q50 12 92 50 Q50 88 8 50 Z" fill="#f6f8ff"/>
    <g clip-path="url(#almond)">
      <g class="iris">
        <circle cx="50" cy="50" r="19" fill="url(#iris)"/>
        <circle cx="50" cy="50" r="19" fill="none" stroke="rgba(15,30,90,.35)" stroke-width="1.5"/>
        <circle cx="50" cy="50" r="8.5" fill="#0b1026"/>
        <circle cx="44" cy="44" r="4" fill="#fff" opacity=".95"/>
        <circle cx="56" cy="55" r="1.8" fill="#fff" opacity=".6"/>
      </g>
    </g>
    <path d="M8 50 Q50 12 92 50" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
    <path d="M8 50 Q50 88 92 50" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="2" stroke-linecap="round"/>
  </g>
  <path class="sparkle" d="M84 16 l2.2 6 6 2.2 -6 2.2 -2.2 6 -2.2 -6 -6 -2.2 6 -2.2 z" fill="#fff"/>
  <path class="sparkle s2" d="M14 76 l1.6 4.2 4.2 1.6 -4.2 1.6 -1.6 4.2 -1.6 -4.2 -4.2 -1.6 4.2 -1.6 z" fill="#bfe9ff"/>
</svg>`;

// Posture: a person at a desk straightens up from a slouch; a check pops in, chevrons rise.
const FIGURE = `
<svg class="figure" viewBox="0 0 100 100" aria-hidden="true">
  <defs>
    <linearGradient id="body" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#1fa67a"/>
      <stop offset="1" stop-color="#8af7c8"/>
    </linearGradient>
  </defs>
  <!-- chair and desk -->
  <path d="M24 34 V80 M24 68 H48 M30 68 V86 M46 68 V86" stroke="rgba(255,255,255,.28)" stroke-width="3.5" stroke-linecap="round" fill="none"/>
  <path d="M64 58 H90 M84 58 V86" stroke="rgba(255,255,255,.28)" stroke-width="3.5" stroke-linecap="round" fill="none"/>
  <!-- legs -->
  <path d="M38 66 H60 V84 H66" stroke="url(#body)" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <!-- upper body pivots at the hips -->
  <g class="torso">
    <path class="spine-glow" d="M37 64 V36" stroke="rgba(138,247,200,.35)" stroke-width="15" stroke-linecap="round"/>
    <path d="M37 64 V36" stroke="url(#body)" stroke-width="8" stroke-linecap="round"/>
    <path d="M37 42 L52 52 L68 52" stroke="#e9fff5" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <circle cx="37" cy="24" r="8.5" fill="#e9fff5"/>
  </g>
  <!-- upward cue -->
  <path class="chev" d="M5 40 l5 -5 5 5" fill="none" stroke="#8af7c8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <path class="chev c2" d="M5 52 l5 -5 5 5" fill="none" stroke="#8af7c8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <!-- check badge -->
  <g class="check">
    <circle cx="78" cy="24" r="10" fill="#1fa67a" stroke="#8af7c8" stroke-width="2"/>
    <path d="M73 24 l3.5 3.5 6.5 -7" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;

const COPY = {
  blink: { title: "Blink slowly", sub: "Close your eyes gently, a few times." },
  posture: { title: "Sit tall", sub: "Lengthen your spine, relax your shoulders." },
};

const body = document.body;
body.classList.add(kind, size, `pos-${position}`);
if (dim) body.classList.add("dim");
body.style.setProperty("--dur", `${duration}s`);
document.getElementById("art")!.innerHTML = kind === "blink" ? EYE : FIGURE;
document.getElementById("title")!.textContent = COPY[kind].title;
document.getElementById("sub")!.textContent = COPY[kind].sub;

requestAnimationFrame(() => body.classList.add("in"));
// Start the exit animation just before the backend closes the window.
setTimeout(() => {
  body.classList.remove("in");
  body.classList.add("out");
}, duration * 1000);
