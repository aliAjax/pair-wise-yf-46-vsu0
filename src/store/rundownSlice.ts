import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type {
  BreakingChange, Denial, EditableField, HistoryEntry, MergeReport, QueuedOp, Role, RundownItem
} from "../types";
import { ACTION_LABEL, canPerform, migrateSnapshot, reconcile, type ActionKind } from "../app/collab";
import { commitOps, loadServer, seedPeerEdits } from "../app/server";

const seed = migrateSnapshot([
  { id: "r1", title: "早间新闻提要", type: "新闻片", duration: 4, hardStart: "08:00", status: "已播出", presenter: "陈默", source: "主控" },
  { id: "r2", title: "城市更新现场连线", type: "连线", duration: 8, hardStart: "08:06", status: "待播", presenter: "陈默", source: "记者周岚" },
  { id: "r3", title: "政策发布会解读", type: "嘉宾", duration: 12, status: "待播", presenter: "陈默", source: "演播室A" },
  { id: "r4", title: "整点广告", type: "广告", duration: 3, hardStart: "08:30", status: "待播", presenter: "系统", source: "广告串" }
] satisfies RundownItem[]);

interface State {
  initialized: boolean;
  migrated: boolean;
  clientId: string;
  role: Role;
  online: boolean;
  items: RundownItem[];
  history: HistoryEntry[];
  queue: QueuedOp[];
  changes: BreakingChange[];
  denials: Denial[];
  /** 硬时间风险轮次：合并后总时长一变即 +1，原风险结论立即失效 */
  riskEpoch: number;
  riskEpochReason: string;
  lastMerge: (MergeReport & { scope: "recovery" | "pull"; submitted: number }) | null;
  lastPullAt: string | null;
  peerSeeded: boolean;
}

const initialState: State = {
  initialized: false,
  migrated: false,
  clientId: "local-导播",
  role: "导播",
  online: true,
  items: seed,
  history: [],
  queue: [],
  changes: [],
  denials: [],
  riskEpoch: 0,
  riskEpochReason: "开播基线",
  lastMerge: null,
  lastPullAt: null,
  peerSeeded: false
};

function snapshot(items: RundownItem[], label: string, detail: string): HistoryEntry {
  return { id: crypto.randomUUID(), label, detail, time: new Date().toISOString(), snapshot: structuredClone(items) };
}

function bumpEpoch(state: State, reason: string) {
  state.riskEpoch += 1;
  state.riskEpochReason = reason;
}

/** 本地应用字段编辑（先改优先）；返回 false 表示被先到修改/播出锁拦下 */
function applyLocalField(state: State, itemId: string, field: EditableField, value: string | number, at: string): boolean {
  const item = state.items.find((i) => i.id === itemId);
  if (!item) return false;
  if (item.status === "已播出") return false;
  const ts = item.fieldTs?.[field];
  const owner = item.fieldOwner?.[field];
  if (owner && owner !== state.clientId && ts && at > ts) return false;
  (item as unknown as Record<string, unknown>)[field] = value;
  item.fieldTs = { ...item.fieldTs, [field]: at };
  item.fieldOwner = { ...item.fieldOwner, [field]: state.clientId };
  return true;
}

function deny(state: State, action: ActionKind, reason: string) {
  state.denials.unshift({ id: crypto.randomUUID(), action: ACTION_LABEL[action], reason, at: new Date().toISOString() });
}

/** 操作同时进应急队列：离线时待恢复提交，在线时也走幂等日志保证不重复 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type OpInput = DistributiveOmit<QueuedOp, "id" | "at" | "client" | "role"> & { id?: string };

function enqueue(state: State, op: OpInput) {
  const full = { ...op, id: op.id ?? crypto.randomUUID(), at: new Date().toISOString(), client: state.clientId, role: state.role } as QueuedOp;
  state.queue.unshift(full);
  return full;
}

const slice = createSlice({
  name: "rundown",
  initialState,
  reducers: {
    bootstrap(state, action: PayloadAction<{ clientId: string; role: Role; online: boolean; items: RundownItem[]; changes: BreakingChange[]; queue: QueuedOp[]; migrated: boolean }>) {
      if (state.initialized) return;
      state.clientId = action.payload.clientId;
      state.role = action.payload.role;
      state.online = action.payload.online;
      state.items = action.payload.items;
      state.changes = action.payload.changes;
      state.queue = action.payload.queue;
      state.migrated = action.payload.migrated;
      state.initialized = true;
    },
    setRole(state, action: PayloadAction<Role>) { state.role = action.payload; },
    setOnline(state, action: PayloadAction<boolean>) { state.online = action.payload; },
    switchClient(state, action: PayloadAction<{ clientId: string; role: Role; online: boolean; items: RundownItem[]; changes: BreakingChange[]; queue: QueuedOp[] }>) {
      state.clientId = action.payload.clientId;
      state.role = action.payload.role;
      state.online = action.payload.online;
      state.items = action.payload.items;
      state.changes = action.payload.changes;
      state.queue = action.payload.queue;
      state.lastMerge = null;
    },

    addItem(state, action: PayloadAction<Omit<RundownItem, "id" | "status" | "fieldTs" | "fieldOwner">>) {
      if (!canPerform(state.role, "add")) { deny(state, "add", deniedText(state.role, "add")); return; }
      const at = new Date().toISOString();
      const item: RundownItem = {
        ...action.payload,
        id: crypto.randomUUID(),
        status: "草稿",
        fieldTs: { title: at, type: at, duration: at, presenter: at, source: at, ...(action.payload.hardStart ? { hardStart: at } : {}) },
        fieldOwner: { title: state.clientId, type: state.clientId, duration: state.clientId, presenter: state.clientId, source: state.clientId, ...(action.payload.hardStart ? { hardStart: state.clientId } : {}) }
      };
      state.history.unshift(snapshot(state.items, "新增条目", action.payload.title));
      state.items.push(item);
      enqueue(state, { type: "add", item });
    },

    updateField(state, action: PayloadAction<{ id: string; field: EditableField; value: string | number }>) {
      if (!canPerform(state.role, "updateField")) { deny(state, "updateField", deniedText(state.role, "updateField")); return; }
      const { id, field, value } = action.payload;
      const item = state.items.find((i) => i.id === id);
      if (!item) return;
      const at = new Date().toISOString();
      if (!applyLocalField(state, id, field, value, at)) {
        deny(state, "updateField", `「${item.title}」已被更早的修改抢先或已播出，本次修改被拒绝`);
        return;
      }
      state.history.unshift(snapshot(state.items, "修改条目", `${item.title} · ${field}`));
      enqueue(state, { type: "updateField", itemId: id, field, value });
    },

    updateStatus(state, action: PayloadAction<{ id: string; status: "已播出" }>) {
      if (!canPerform(state.role, "status")) { deny(state, "status", deniedText(state.role, "status")); return; }
      const item = state.items.find((i) => i.id === action.payload.id);
      if (!item || item.status === "已播出") return; // 已播出不可回退
      state.history.unshift(snapshot(state.items, "播出状态", `${item.title} → 已播出`));
      item.status = "已播出";
      enqueue(state, { type: "status", itemId: item.id, status: "已播出" });
    },

    reorder(state, action: PayloadAction<RundownItem[]>) {
      if (!canPerform(state.role, "reorder")) { deny(state, "reorder", deniedText(state.role, "reorder")); return; }
      state.history.unshift(snapshot(state.items, "调整顺序", "直播串联单顺序变化"));
      state.items = action.payload;
      enqueue(state, { type: "reorder", orderedIds: action.payload.map((i) => i.id) });
    },

    adjustDuration(state, action: PayloadAction<{ id: string; delta: number }>) {
      if (!canPerform(state.role, "updateField")) { deny(state, "updateField", deniedText(state.role, "updateField")); return; }
      const current = state.items.find((i) => i.id === action.payload.id);
      if (!current) return;
      const value = Math.max(1, current.duration + action.payload.delta);
      const at = new Date().toISOString();
      if (!applyLocalField(state, current.id, "duration", value, at)) {
        deny(state, "updateField", `「${current.title}」时长已被更早的修改抢先或已播出，本次调整被拒绝`);
        return;
      }
      state.history.unshift(snapshot(state.items, "调整时长", `${current.title} ${action.payload.delta > 0 ? "增加" : "减少"} ${Math.abs(action.payload.delta)} 分钟`));
      enqueue(state, { type: "updateField", itemId: current.id, field: "duration", value });
    },

    insertBreaking(state, action: PayloadAction<Omit<BreakingChange, "id" | "createdAt" | "client">>) {
      if (!canPerform(state.role, "breaking")) { deny(state, "breaking", deniedText(state.role, "breaking")); return; }
      const at = new Date().toISOString();
      const payload = action.payload;
      const index = state.items.findIndex((item) => item.id === payload.insertAfter);
      const item: RundownItem = {
        id: crypto.randomUUID(), title: payload.headline, type: "新闻片", duration: payload.duration,
        status: "待播", presenter: "值班主播", source: `插播：${payload.reason}`,
        fieldTs: { title: at, type: at, duration: at, presenter: at, source: at },
        fieldOwner: { title: state.clientId, type: state.clientId, duration: state.clientId, presenter: state.clientId, source: state.clientId }
      };
      state.history.unshift(snapshot(state.items, "突发插播", payload.headline));
      state.items.splice(index + 1, 0, item);
      const change: BreakingChange = { ...payload, id: item.id, createdAt: at, client: state.clientId };
      state.changes.unshift(change);
      // 突发插播进入应急队列，恢复时只提交尚未落地的操作
      enqueue(state, { type: "breaking", item, insertAfter: payload.insertAfter, change });
    },

    skipItem(state, action: PayloadAction<string>) {
      if (!canPerform(state.role, "skip")) { deny(state, "skip", deniedText(state.role, "skip")); return; }
      const item = state.items.find((entry) => entry.id === action.payload);
      if (!item || item.status === "已播出") return; // 已播出不能被取消盖掉
      state.history.unshift(snapshot(state.items, "取消条目", item.title));
      item.status = "已跳过";
      enqueue(state, { type: "skip", itemId: item.id });
    },

    undo(state) {
      const last = state.history.shift();
      if (!last) return;
      state.items = structuredClone(last.snapshot);
    },

    /** 采纳服务端合并结果（恢复提交 / 在线拉取对端改动） */
    adoptMerge(state, action: PayloadAction<{ report: MergeReport; scope: "recovery" | "pull"; submitted: number }>) {
      const { report, scope, submitted } = action.payload;
      const landed = new Set([...report.landed, ...report.duplicateIds]);
      state.items = report.items;
      state.changes = report.changes;
      // 恢复时只保留尚未落地的操作（重复恢复留下的队列不会被二次提交）
      state.queue = state.queue.filter((op) => !landed.has(op.id));
      state.lastMerge = { ...report, scope, submitted };
      state.lastPullAt = report.at;
      if (report.durationChanged) {
        // 合并后时长一旦变化，原硬时间风险立即失效并重新计算
        bumpEpoch(state, scope === "recovery" ? "断网恢复合并后重算" : "在线同步到对端改动后重算");
      }
      if (scope === "recovery") {
        state.history.unshift({
          id: crypto.randomUUID(), label: "断网恢复合并",
          detail: `提交 ${submitted} 项，落地 ${report.landed.length} 项，去重 ${report.duplicateIds.length} 项，冲突拦截 ${report.conflicts.length} 项${report.durationChanged ? `，总时长 ${report.durationBefore}→${report.durationAfter} 分钟并重算风险` : ""}`,
          time: report.at, snapshot: structuredClone(state.items)
        });
      }
    },

    markPeerSeeded(state) { state.peerSeeded = true; },
    acknowledgeDenial(state, action: PayloadAction<string>) {
      state.denials = state.denials.filter((d) => d.id !== action.payload);
    }
  }
});

function deniedText(role: Role, action: ActionKind): string {
  return role === "字幕"
    ? `字幕岗位无权修改串联单（${ACTION_LABEL[action]}已拒绝）`
    : role === "演播室"
      ? `演播室岗位只能标记已播出（${ACTION_LABEL[action]}已拒绝）`
      : `${role}岗位无权执行${ACTION_LABEL[action]}`;
}

/* ---------------- 异步：恢复提交 / 在线同步 ---------------- */

export const recoverQueue = createAsyncThunk("rundown/recover", async (_: { quiet?: boolean } | undefined, { getState, dispatch }) => {
  const s = (getState() as { rundown: State }).rundown;
  if (!s.online) return { skipped: true };
  const submitted = s.queue;
  if (!submitted.length) return { skipped: true };
  // 提交前先拉服务端权威单作为合并基线（包含另一台终端的排片）
  const server = loadServer();
  const chronological = [...submitted].sort((a, b) => a.at.localeCompare(b.at));
  // commitOps 在服务端持久化同一套合并结果，并追加幂等日志
  commitOps(submitted);
  const report = reconcile(server.items, chronological, server.landedIds, server.changes);
  dispatch(slice.actions.adoptMerge({ report, scope: "recovery", submitted: submitted.length }));
  return { skipped: false, report };
});

export const pullServer = createAsyncThunk("rundown/pull", async (_: void, { getState, dispatch }) => {
  const s = (getState() as { rundown: State }).rundown;
  if (!s.online) return;
  const server = loadServer();
  if (JSON.stringify(server.items.map(strip)) === JSON.stringify(s.items.map(strip))) return;
  // 有待提交操作时先自动提交（恢复），再采纳合并结果
  if (s.queue.length) {
    await dispatch(recoverQueue({ quiet: true }));
    return;
  }
  const report = reconcile(s.items, [], [], server.changes);
  report.items = server.items;
  report.durationAfter = server.items.reduce((sum, i) => sum + i.duration, 0);
  report.durationBefore = s.items.reduce((sum, i) => sum + i.duration, 0);
  report.durationChanged = report.durationBefore !== report.durationAfter;
  report.at = new Date().toISOString();
  dispatch(slice.actions.adoptMerge({ report, scope: "pull", submitted: 0 }));
});

export const seedPeer = createAsyncThunk("rundown/seed-peer", async (_: void, { dispatch }) => {
  seedPeerEdits();
  dispatch(slice.actions.markPeerSeeded());
  dispatch(pullServer());
});

function strip(item: RundownItem) {
  const { fieldTs: _ts, fieldOwner: _o, ...rest } = item;
  return rest;
}

export const {
  bootstrap, setRole, setOnline, switchClient, addItem, updateField, updateStatus,
  reorder, adjustDuration, insertBreaking, skipItem, undo, adoptMerge, acknowledgeDenial
} = slice.actions;
export default slice.reducer;
