import type { BreakingChange, QueuedOp, RundownItem } from "../types";
import { migrateSnapshot, reconcile } from "./collab";

/**
 * 用 localStorage 模拟主链路服务端：
 * - SNAP_KEY  权威串联单快照
 * - LOG_KEY   已落地操作幂等日志（重复恢复不重复插入）
 * - NEWS_KEY  权威突发记录
 * - PEER_KEY  供“双终端”演示的终端偏好
 */
const SNAP_KEY = "pair-wise-yf-46/rundown";
const LOG_KEY = "pair-wise-yf-46/op-log";
const NEWS_KEY = "pair-wise-yf-46/changes";
const PEER_KEY = "pair-wise-yf-46/peer";

const seed: RundownItem[] = [
  { id: "r1", title: "早间新闻提要", type: "新闻片", duration: 4, hardStart: "08:00", status: "已播出", presenter: "陈默", source: "主控" },
  { id: "r2", title: "城市更新现场连线", type: "连线", duration: 8, hardStart: "08:06", status: "待播", presenter: "陈默", source: "记者周岚" },
  { id: "r3", title: "政策发布会解读", type: "嘉宾", duration: 12, status: "待播", presenter: "陈默", source: "演播室A" },
  { id: "r4", title: "整点广告", type: "广告", duration: 3, hardStart: "08:30", status: "待播", presenter: "系统", source: "广告串" }
];

function readJSON<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) as T : fallback;
}

export interface ServerState {
  items: RundownItem[];
  changes: BreakingChange[];
  landedIds: string[];
  migrated: boolean;
}

export function loadServer(): ServerState {
  const raw = localStorage.getItem(SNAP_KEY);
  let migrated = false;
  let items: RundownItem[];
  if (raw === null) {
    items = migrateSnapshot(seed);
  } else {
    const parsed = JSON.parse(raw) as RundownItem[];
    // 旧数据（无 fieldTs）升级后继续可用
    items = migrateSnapshot(parsed);
    migrated = parsed.some((i) => !i.fieldTs);
  }
  localStorage.setItem(SNAP_KEY, JSON.stringify(items));
  return {
    items,
    changes: readJSON<BreakingChange[]>(NEWS_KEY, []),
    landedIds: readJSON<string[]>(LOG_KEY, []),
    migrated
  };
}

/** 恢复时提交：只重放尚未落地的操作，服务端返回合并报告 */
export function commitOps(ops: QueuedOp[]): { items: RundownItem[]; changes: BreakingChange[]; landedIds: string[] } {
  const server = loadServer();
  const chronological = [...ops].sort((a, b) => a.at.localeCompare(b.at));
  const report = reconcile(server.items, chronological, server.landedIds, server.changes);
  localStorage.setItem(SNAP_KEY, JSON.stringify(report.items));
  localStorage.setItem(NEWS_KEY, JSON.stringify(report.changes));
  const landedIds = [...new Set([...server.landedIds, ...report.landed])];
  localStorage.setItem(LOG_KEY, JSON.stringify(landedIds));
  return { items: report.items, changes: report.changes, landedIds };
}

/** 演示用：把“另一台终端（主编）”断网期间的排片直接写进服务端权威单 */
export function seedPeerEdits(): { items: RundownItem[]; changes: BreakingChange[] } {
  const server = loadServer();
  // 早于当前时间 90 秒，保证本机随后的同字段编辑在合并时被判为“后到修改”
  const at = new Date(Date.now() - 90_000).toISOString();
  const peer = "local-主编";
  const ops: QueuedOp[] = [];

  const r2 = server.items.find((i) => i.id === "r2");
  if (r2 && r2.status !== "已播出" && r2.fieldOwner?.duration !== peer) {
    ops.push({ id: `peer-op-duration-r2-${at}`, type: "updateField", at, client: peer, role: "主编", itemId: "r2", field: "duration", value: 10 });
  }
  if (!server.items.some((i) => i.id === "peer-r5")) {
    ops.push({
      id: `peer-op-add-r5-${at}`, type: "add", at, client: peer, role: "主编",
      item: {
        id: "peer-r5", title: "记者连线补充稿", type: "口播", duration: 2, status: "待播", presenter: "陈默", source: "主编加单",
        fieldTs: { title: at, type: at, duration: at, presenter: at, source: at },
        fieldOwner: { title: peer, type: peer, duration: peer, presenter: peer, source: peer }
      }
    });
  }
  return commitOps(ops);
}

export function savePeerPrefs(prefs: Record<string, unknown>): void {
  localStorage.setItem(PEER_KEY, JSON.stringify(prefs));
}

export function clearOpLog(): void {
  localStorage.removeItem(LOG_KEY);
}
