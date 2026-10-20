// FarSight's line icons (24x24, currentColor). Drawn for this project.
const svg = (body: string, fill = false) =>
  `<svg viewBox="0 0 24 24" fill="${fill ? "currentColor" : "none"}" stroke="${fill ? "none" : "currentColor"}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS = {
  hourglass: svg(`<path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9"/>`),
  bolt: svg(`<path d="M13.5 2 5 13.5h6L10 22l9-12h-6.2z"/>`, true),
  leaf: svg(`<path d="M5 19c0-9 5-14 15-14 0 10-5 15-14 15"/><path d="M5 19 13 11"/>`),
  check: svg(`<path d="m5 12.5 4.5 4.5L19 7.5"/>`),
  gear: svg(
    `<path d="M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.5 7.5 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 2.6-1.5l2.4 1 2-3.4z"/>`,
  ),
  calendar: svg(`<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>`),
  eye: svg(`<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>`),
  pause: svg(`<rect x="6.5" y="5" width="3.6" height="14" rx="1"/><rect x="13.9" y="5" width="3.6" height="14" rx="1"/>`, true),
  play: svg(`<path d="M8 5.5v13a1 1 0 0 0 1.5.9l10.4-6.5a1 1 0 0 0 0-1.8L9.5 4.6A1 1 0 0 0 8 5.5z"/>`, true),
  skip: svg(`<path d="m6 6 7 6-7 6zM16.5 6v12"/>`),
  restart: svg(`<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/>`),
  zzz: svg(`<path d="M5 6h6l-6 7h6M14 11h5l-5 6h5"/>`),
  sun: svg(`<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>`),
  posture: svg(`<circle cx="12" cy="4.5" r="2"/><path d="M12 7.5v8M8 10.5h8M9.5 21l2.5-5.5 2.5 5.5"/>`),
  call: svg(`<path d="M6.6 3.5h2.6l1.6 4.2-2 1.5a12 12 0 0 0 6 6l1.5-2 4.2 1.6v2.6a2 2 0 0 1-2.2 2A17.5 17.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z"/>`),
  target: svg(`<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>`),
  screen: svg(`<rect x="2.5" y="4" width="19" height="13" rx="2.5"/><path d="M8.5 21h7M12 17v4"/>`),
  chart: svg(`<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>`),
  bell: svg(`<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 21h4"/>`),
  palette: svg(`<path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.9 1.4-2-.5-1.3.4-2.6 1.8-2.6H18a3 3 0 0 0 3-3C21 7 17 3 12 3z"/><circle cx="7.5" cy="11" r="1.2" fill="currentColor"/><circle cx="10.5" cy="7.2" r="1.2" fill="currentColor"/><circle cx="15" cy="7.5" r="1.2" fill="currentColor"/>`),
  info: svg(`<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>`),
  sparkle: svg(`<path d="M12 3c.6 4.4 2.6 6.4 7 7-4.4.6-6.4 2.6-7 7-.6-4.4-2.6-6.4-7-7 4.4-.6 6.4-2.6 7-7z"/>`, true),
  close: svg(`<path d="M6 6l12 12M18 6 6 18"/>`),
  chevronL: svg(`<path d="m15 5-7 7 7 7"/>`),
  chevronR: svg(`<path d="m9 5 7 7-7 7"/>`),
};

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, tile?: string, size: "" | "lg" = ""): HTMLElement {
  const span = document.createElement("span");
  span.className = tile ? `tile ${tile} ${size}` : "icon";
  span.innerHTML = ICONS[name];
  return span;
}
