// Synthesised sound effects (no audio files are bundled).
import type { Settings, SoundPair } from "../shared/types";
import { api, bridge } from "./api";

const ctx = new AudioContext();
let settings: Settings | null = null;

interface Note {
  freq: number;
  at: number; // seconds offset
  dur: number;
  type?: OscillatorType;
  gain?: number;
}

function playNotes(notes: Note[], volume: number): void {
  const t0 = ctx.currentTime + 0.02;
  const master = ctx.createGain();
  master.gain.value = volume;
  master.connect(ctx.destination);
  for (const n of notes) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = n.type ?? "sine";
    osc.frequency.value = n.freq;
    const start = t0 + n.at;
    const peak = n.gain ?? 0.4;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
    osc.connect(g).connect(master);
    osc.start(start);
    osc.stop(start + n.dur + 0.05);
  }
}

function sweep(from: number, to: number, dur: number, volume: number): void {
  const t0 = ctx.currentTime + 0.02;
  const src = ctx.createBufferSource();
  const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.6;
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = 2.5;
  filter.frequency.setValueAtTime(from, t0);
  filter.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(volume, t0 + dur * 0.4);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter).connect(g).connect(ctx.destination);
  src.start(t0);
}

const chord = (freqs: number[], step: number, dur: number, type: OscillatorType = "sine", gain = 0.35): Note[] =>
  freqs.map((freq, i) => ({ freq, at: i * step, dur, type, gain }));

// Start = rising, end = falling, per sound pair.
const PAIRS: Record<Exclude<SoundPair, "none" | "whoosh">, { start: Note[]; end: Note[] }> = {
  chime: { start: chord([659.25, 880, 1318.5], 0.12, 1.4), end: chord([1318.5, 880, 659.25], 0.12, 1.4) },
  bell: {
    start: [...chord([523.25], 0, 2.4, "sine", 0.5), ...chord([1046.5 * 1.5], 0, 1.2, "sine", 0.12)],
    end: [...chord([392], 0, 2.4, "sine", 0.5), ...chord([784 * 1.5], 0, 1.2, "sine", 0.12)],
  },
  harp: { start: chord([392, 493.88, 587.33, 783.99, 987.77], 0.07, 1.6, "triangle", 0.22), end: chord([987.77, 783.99, 587.33, 493.88, 392], 0.07, 1.6, "triangle", 0.22) },
  bubbles: {
    start: [0, 1, 2, 3].map((i) => ({ freq: 500 + i * 180, at: i * 0.09, dur: 0.12, gain: 0.3 })),
    end: [3, 2, 1, 0].map((i, k) => ({ freq: 500 + i * 180, at: k * 0.09, dur: 0.12, gain: 0.3 })),
  },
  piano: { start: chord([261.63, 329.63, 392, 523.25], 0.05, 1.8, "triangle", 0.25), end: chord([523.25, 392, 329.63, 261.63], 0.05, 1.8, "triangle", 0.25) },
};

const EFFECTS: Record<string, Note[]> = {
  nudge: chord([880, 1174.66], 0.1, 0.5, "sine", 0.25),
  blink: chord([1567.98], 0, 0.6, "sine", 0.18),
  posture: chord([783.99, 1046.5], 0.14, 0.7, "sine", 0.2),
  return: chord([523.25, 659.25, 783.99], 0.09, 0.8, "sine", 0.2),
};

bridge.on("sound", ({ sound, pair, volume }: { sound: string; pair: SoundPair; volume?: number }) => {
  void ctx.resume();
  const vol = volume ?? settings?.breakSoundsVolume ?? 0.6;
  if (sound === "start" || sound === "end") {
    if (pair === "none") return;
    if (pair === "whoosh") return sweep(sound === "start" ? 300 : 3000, sound === "start" ? 3000 : 300, 1.1, vol * 0.8);
    return playNotes(PAIRS[pair][sound], vol);
  }
  if (sound.startsWith("pair:")) {
    const p = sound.slice(5) as SoundPair;
    if (p === "whoosh") return sweep(300, 3000, 1.1, vol * 0.8);
    if (p !== "none") playNotes(PAIRS[p].start, vol);
    return;
  }
  const fx = EFFECTS[sound];
  if (fx) playNotes(fx, vol);
});

void api.settings().then((s) => (settings = s));
api.onSettings((s) => (settings = s));
