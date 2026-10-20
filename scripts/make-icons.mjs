// Renders FarSight's app and tray icons to PNG without external tools.
// Run: node scripts/make-icons.mjs
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function png(width, height, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Render with 4x4 supersampling. shade(u, v) -> [r,g,b,a] in 0..1, with u,v in -1..1. */
function render(size, shade) {
  const out = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = ((x + (sx + 0.5) / ss) / size) * 2 - 1;
          const v = ((y + (sy + 0.5) / ss) / size) * 2 - 1;
          const [cr, cg, cb, ca] = shade(u, v);
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      out[i + 3] = Math.round((a / n) * 255);
      if (a > 0) {
        out[i] = Math.round((r / a) * 255);
        out[i + 1] = Math.round((g / a) * 255);
        out[i + 2] = Math.round((b / a) * 255);
      }
    }
  }
  return out;
}

// Almond eye shape: intersection of two circles offset vertically.
const eyeSdf = (u, v, w, h) => {
  const R = (w * w + h * h) / (2 * h);
  const d1 = Math.hypot(u, v - (R - h)) - R;
  const d2 = Math.hypot(u, v + (R - h)) - R;
  return Math.max(d1, d2);
};

const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);

function appIcon(u, v) {
  // Rounded square background (macOS-style squircle approximation).
  const k = 0.82, rad = 0.22;
  const qx = Math.abs(u) - k + rad, qy = Math.abs(v) - k + rad;
  const box = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;
  if (box > 0) return [0, 0, 0, 0];
  const t = (v + 1) / 2;
  let col = mix([0.11, 0.2, 0.42], [0.17, 0.33, 0.39], t);
  // Horizon glow
  const glow = Math.exp(-((v - 0.38) ** 2) / 0.02) * 0.35;
  col = mix(col, [0.49, 0.77, 1.0], glow);
  const eye = eyeSdf(u, v, 0.62, 0.36);
  if (eye < 0) {
    col = [0.96, 0.97, 0.99];
    const d = Math.hypot(u, v);
    if (d < 0.27) col = mix([0.29, 0.66, 1.0], [0.15, 0.4, 0.75], d / 0.27);
    if (d < 0.13) col = [0.04, 0.06, 0.12];
    if (Math.hypot(u + 0.06, v + 0.07) < 0.045) col = [1, 1, 1];
  } else if (eye < 0.035) {
    col = mix(col, [0.96, 0.97, 0.99], 0.25);
  }
  return [...col, 1];
}

/** Monochrome tray glyph: eye outline + pupil. */
const trayGlyph = (color) => (u, v) => {
  const e = eyeSdf(u, v * 1.05, 0.9, 0.52);
  const outline = Math.abs(e) < 0.1;
  const pupil = Math.hypot(u, v) < 0.3;
  return outline || pupil ? [...color, 1] : [0, 0, 0, 0];
};

mkdirSync(join(root, "build/tray"), { recursive: true });
writeFileSync(join(root, "build/icon.png"), png(1024, 1024, render(1024, appIcon)));
for (const [name, size] of [["trayTemplate.png", 18], ["trayTemplate@2x.png", 36]]) {
  writeFileSync(join(root, "build/tray", name), png(size, size, render(size, trayGlyph([0, 0, 0]))));
}
// Windows tray: light glyph for dark taskbars, dark glyph for light taskbars.
writeFileSync(join(root, "build/tray/tray-light.png"), png(32, 32, render(32, trayGlyph([1, 1, 1]))));
writeFileSync(join(root, "build/tray/tray-dark.png"), png(32, 32, render(32, trayGlyph([0.1, 0.1, 0.12]))));
console.log("icons written to build/");
