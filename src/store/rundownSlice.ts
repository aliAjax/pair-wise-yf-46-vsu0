import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { BreakingChange, HistoryEntry, MergeResult, PendingChange, Permission, Role, RundownItem } from "../types";
import { can } from "./permissions";
import { rundownApi } from "./api";
import type { RootState } from "./index";

const seed: RundownItem[] = [
  { id: "r1", title: "早间新闻提要", type: "新闻片", duration: 4, hardStart: "08:00", status: "已播出", presenter: "陈默", source: "主控", version: 1 },
  { id: "r2", title: "城市更新现场连线", type: "连线", duration: 8, hardStart: "08:06", status: "待播", presenter: "陈默", source: "记者周岚", version: 1 },
  { id: "r3", title: "政策发布会解读", type: "嘉宾", duration: 12, status: "待播", presenter: "陈默", source: "演播室A", version: 1 },
  { id: "r4", title: "整点广告", type: "广告", duration: 3, hardStart: "08:30", status: "待播", presenter: "系统", source: "广告串", version: 1 }
];

interface State {
  initialized: boolean;
  items: RundownItem[];
  history: HistoryEntry[];
  queue: PendingChange[];
  changes: BreakingChange[];
  role: Role;
  online: boolean;
}

const initialState: State = { initialized: false, items: seed, history: [], queue: [], changes: [], role: "导播", online: true };

function snapshot(items: RundownItem[], label: string, detail: string): HistoryEntry {
  return { id: crypto.randomUUID(), label, detail, time: new Date().toISOString(), snapshot: structuredClone(items) };
}

/** 岗位权限守卫：越权操作不落地，只记审计 */
function guard(state: State, permission: Permission, label: string): boolean {
  if (can(state.role, permission)) return true;
  state.history.unshift(snapshot(state.items, "越权拒绝", `${state.role} 岗位无权「${label}」`));
  return false;
}

/** 断网操作入队：携带幂等键、载荷与基于版本，恢复时回放 */
function enqueue(state: State, action: string, detail: string, field: string, payload: unknown) {
  state.queue.push({
    id: crypto.randomUUID(),
    opId: crypto.randomUUID(),
    action,
    detail,
    field,
    payload,
    baseVersion: state.items.reduce((max, item) => Math.max(max, item.version), 1),
    queuedAt: new Date().toISOString(),
    status: "pending"
  });
}

/** 旧版队列条目升级：缺载荷 / 缺幂等键的无法回放，标记拒绝 */
function migrateQueue(raw: unknown): PendingChange[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const item = entry as Partial<PendingChange> & { action?: string; detail?: string };
    if (typeof item.opId === "string" && item.payload !== undefined) return item as PendingChange;
    return {
      id: typeof item.id === "string" ? item.id : crypto.randomUUID(),
      opId: typeof item.opId === "string" ? item.opId : crypto.randomUUID(),
      action: item.action ?? "未知操作",
      detail: item.detail ?? "",
      queuedAt: item.queuedAt ?? new Date().toISOString(),
      baseVersion: typeof item.baseVersion === "number" ? item.baseVersion : 1,
      payload: item.payload ?? null,
      status: "rejected" as const,
      reason: "旧版队列数据已升级，缺少操作载荷，无法回放"
    };
  });
}

const slice = createSlice({
  name: "rundown",
  initialState,
  reducers: {
    initialize(state, action: PayloadAction<{ items: RundownItem[]; queue?: unknown }>) {
      if (state.initialized) return;
      const items = action.payload.items.length
        ? action.payload.items.map((item) => ({ ...item, version: typeof item.version === "number" ? item.version : 1 }))
        : seed;
      state.items = items;
      state.queue = migrateQueue(action.payload.queue);
      state.initialized = true;
    },
    setRole(state, action: PayloadAction<Role>) { state.role = action.payload; },
    setOnline(state, action: PayloadAction<boolean>) { state.online = action.payload; },
    /** 合并 / 对端模拟后，用权威条目覆盖本地 */
    setItems(state, action: PayloadAction<RundownItem[]>) { state.items = action.payload; },
    /** UI 层越权尝试：记审计（不落地） */
    deny(state, action: PayloadAction<{ permission: Permission; label: string }>) {
      state.history.unshift(snapshot(state.items, "越权拒绝", `${state.role} 岗位无权「${action.payload.label}」`));
    },
    addItem(state, action: PayloadAction<Omit<RundownItem, "id" | "status" | "version" | "createdByOp">>) {
      if (!guard(state, "add", "新增条目")) return;
      state.history.unshift(snapshot(state.items, "新增条目", action.payload.title));
      state.items.push({ ...action.payload, id: crypto.randomUUID(), status: "草稿", version: 1, updatedBy: state.role });
      if (!state.online) enqueue(state, "新增条目", action.payload.title, "add", { ...action.payload, role: state.role });
    },
    updateStatus(state, action: PayloadAction<{ id: string; status: RundownItem["status"] }>) {
      if (!guard(state, "status", "播出状态")) return;
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      state.history.unshift(snapshot(state.items, "播出状态", `${item.title} → ${action.payload.status}`));
      item.status = action.payload.status;
      if (state.online) { item.version += 1; item.updatedBy = state.role; }
      if (!state.online) enqueue(state, "播出状态", `${item.title} → ${action.payload.status}`, "status", { id: item.id, status: action.payload.status, role: state.role });
    },
    reorder(state, action: PayloadAction<RundownItem[]>) {
      if (!guard(state, "reorder", "调整顺序")) return;
      state.history.unshift(snapshot(state.items, "调整顺序", "直播串联单顺序变化"));
      state.items = action.payload;
      if (state.online) {
        for (const item of state.items) { item.version += 1; item.updatedBy = state.role; }
      }
      if (!state.online) enqueue(state, "调整顺序", "直播串联单顺序变化", "reorder", { orderedIds: action.payload.map((item) => item.id), role: state.role });
    },
    adjustDuration(state, action: PayloadAction<{ id: string; delta: number }>) {
      if (!guard(state, "duration", "调整时长")) return;
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      state.history.unshift(snapshot(state.items, "调整时长", `${item.title} ${action.payload.delta > 0 ? "增加" : "减少"} ${Math.abs(action.payload.delta)} 分钟`));
      item.duration = Math.max(1, item.duration + action.payload.delta);
      if (state.online) { item.version += 1; item.updatedBy = state.role; }
      if (!state.online) enqueue(state, "调整时长", `${item.title} ${action.payload.delta > 0 ? "增加" : "减少"} ${Math.abs(action.payload.delta)} 分钟`, "duration", { id: item.id, delta: action.payload.delta, role: state.role });
    },
    insertBreaking(state, action: PayloadAction<Omit<BreakingChange, "id" | "createdAt">>) {
      if (!guard(state, "breaking", "突发插播")) return;
      const change: BreakingChange = { ...action.payload, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
      const index = state.items.findIndex((item) => item.id === change.insertAfter);
      state.history.unshift(snapshot(state.items, "突发插播", change.headline));
      state.items.splice(index + 1, 0, { id: crypto.randomUUID(), title: change.headline, type: "新闻片", duration: change.duration, status: "待播", presenter: "值班主播", source: `插播：${change.reason}`, version: 1, updatedBy: state.role });
      state.changes.unshift(change);
      if (!state.online) enqueue(state, "突发插播", change.headline, "breaking", { headline: change.headline, duration: change.duration, insertAfter: change.insertAfter, reason: change.reason, role: state.role });
    },
    skipItem(state, action: PayloadAction<string>) {
      if (!guard(state, "skip", "取消条目")) return;
      const item = state.items.find((entry) => entry.id === action.payload);
      if (!item) return;
      state.history.unshift(snapshot(state.items, "取消条目", item.title));
      item.status = "已跳过";
      if (state.online) { item.version += 1; item.updatedBy = state.role; }
      if (!state.online) enqueue(state, "取消条目", item.title, "skip", { id: item.id, role: state.role });
    },
    undo(state) {
      if (!guard(state, "undo", "撤回上一步")) return;
      const last = state.history.shift();
      if (!last) return;
      state.items = structuredClone(last.snapshot);
    },
    /** 合并结果落地：权威条目覆盖本地，队列条目按 opId 标记 landed / rejected */
    applyMerge(state, action: PayloadAction<MergeResult>) {
      state.items = action.payload.items;
      for (const outcome of action.payload.outcomes) {
        const entry = state.queue.find((item) => item.opId === outcome.opId);
        if (!entry) continue;
        entry.status = outcome.status;
        entry.reason = outcome.reason;
        entry.landedAt = outcome.status === "landed" ? new Date().toISOString() : undefined;
      }
    },
    clearFinished(state) {
      state.queue = state.queue.filter((item) => item.status === "pending");
    }
  }
});

/** 断网应急队列恢复：只提交尚未落地（pending）的操作 */
export const syncOfflineQueue = createAsyncThunk<MergeResult | { skipped: true }, void, { state: RootState }>(
  "rundown/syncOfflineQueue",
  async (_args, { getState, dispatch }) => {
    const pending = getState().rundown.queue.filter((item) => item.status === "pending");
    if (!pending.length) return { skipped: true };
    const result = await dispatch(rundownApi.endpoints.mergeQueue.initiate(pending)).unwrap();
    dispatch(applyMerge(result));
    return result;
  }
);

export const {
  initialize, setRole, setOnline, setItems, deny,
  addItem, updateStatus, reorder, adjustDuration, insertBreaking, skipItem, undo,
  applyMerge, clearFinished
} = slice.actions;
export default slice.reducer;
