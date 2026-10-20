// Typed access to the preload bridge from renderer pages.
import type { EngineSnapshot, Settings, StatsSummary } from "../shared/types";

interface Bridge {
  platform: string;
  cmd: (name: string, ...args: unknown[]) => Promise<any>;
  on: (channel: "state" | "settings" | "sound" | "open-tab", cb: (payload: any) => void) => () => void;
}

export const bridge = (window as unknown as { farsight: Bridge }).farsight;

export const api = {
  state: (): Promise<EngineSnapshot> => bridge.cmd("getState"),
  settings: (): Promise<Settings> => bridge.cmd("getSettings"),
  stats: (): Promise<StatsSummary> => bridge.cmd("getStats"),
  setSettings: (patch: Partial<Settings>): Promise<Settings> => bridge.cmd("setSettings", patch),
  cmd: bridge.cmd,
  onState: (cb: (s: EngineSnapshot) => void) => bridge.on("state", cb),
  onSettings: (cb: (s: Settings) => void) => bridge.on("settings", cb),
};

export const GRADIENTS = [
  ["#0f2027", "#203a43", "#2c5364"],
  ["#140c4a", "#2a1a8c", "#9b5cf6"],
  ["#0b3d2e", "#15624a", "#3d8361"],
  ["#2b1055", "#7597de", "#d3a4ff"],
  ["#3a1c71", "#d76d77", "#ffaf7b"],
  ["#000428", "#004e92", "#2a7fb8"],
  ["#232526", "#414345", "#5d6066"],
  ["#42275a", "#734b6d", "#b07aa1"],
];

export const gradientCss = (i: number) => {
  const g = GRADIENTS[((i % GRADIENTS.length) + GRADIENTS.length) % GRADIENTS.length];
  return `radial-gradient(1200px 800px at 20% 10%, ${g[2]}55, transparent 60%), radial-gradient(900px 700px at 85% 90%, ${g[1]}aa, transparent 60%), linear-gradient(160deg, ${g[0]}, ${g[1]})`;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Omit<Partial<HTMLElementTagNameMap[K]>, "style"> & { class?: string; style?: string } = {} as never,
  ...children: (Node | string | null | false | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: cls, style, ...rest } = props as Record<string, unknown>;
  if (cls) node.className = cls as string;
  if (style) node.setAttribute("style", style as string);
  Object.assign(node, rest);
  for (const c of children) if (c != null && c !== false) node.append(c as Node | string);
  return node;
}
