import { formatClock } from "../shared/messages";
import type { EngineSnapshot } from "../shared/types";
import { api } from "./api";
import { ICONS } from "./icons";

let threshold = 10;
document.getElementById("glyph")!.innerHTML = ICONS.eye;

function render(s: EngineSnapshot): void {
  const left = Math.max(0, Math.ceil(s.remaining));
  document.getElementById("num")!.textContent = left >= 60 ? formatClock(left) : `${left}s`;
  const pct = Math.min(100, Math.max(0, 100 * (1 - left / threshold)));
  document.getElementById("ring")!.style.setProperty("--p", `${pct}%`);
}

(async () => {
  threshold = (await api.settings()).countdownThreshold || 10;
  render(await api.state());
  api.onState(render);
})();
