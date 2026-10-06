import type { QueuedOp, Role, RundownItem, TerminalPrefs } from "../types";

/** 每个终端（导播台 / 主编台）各自持久化断网期间的应急队列与岗位偏好 */
const key = (clientId: string) => `pair-wise-yf-46/client/${clientId}`;

interface ClientBlob {
  prefs: TerminalPrefs;
  queue: QueuedOp[];
  items: RundownItem[];
}

export function loadClient(clientId: string, fallbackPrefs: TerminalPrefs): ClientBlob {
  const raw = localStorage.getItem(key(clientId));
  if (!raw) return { prefs: fallbackPrefs, queue: [], items: [] };
  const parsed = JSON.parse(raw) as Partial<ClientBlob>;
  return {
    prefs: { ...fallbackPrefs, ...parsed.prefs },
    queue: Array.isArray(parsed.queue) ? parsed.queue : [],
    items: Array.isArray(parsed.items) ? parsed.items : []
  };
}

export function saveClient(clientId: string, blob: ClientBlob): void {
  localStorage.setItem(key(clientId), JSON.stringify(blob));
}

export const TERMINALS: { id: string; label: string; defaultRole: Role }[] = [
  { id: "local-导播", label: "1 号终端 · 导播台", defaultRole: "导播" },
  { id: "local-主编", label: "2 号终端 · 主编台", defaultRole: "主编" }
];
