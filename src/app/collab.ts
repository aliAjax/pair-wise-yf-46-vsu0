import type {
  BreakingChange, EditableField, ItemStatus, MergeConflict, MergeReport, QueuedOp, Role, RundownItem
} from "../types";

/* ---------------- 岗位权限矩阵 ----------------
 * 字幕岗位只负责字幕机内容，对编排台串联单没有任何写权限；
 * 演播室只能标记“已播出”；导播/主编可排片（突发插播与取消限导播）。 */

export type ActionKind =
  | "add" | "updateField" | "status" | "reorder" | "skip" | "breaking";

const MATRIX: Record<Role, ActionKind[]> = {
  导播: ["add", "updateField", "status", "reorder", "skip", "breaking"],
  主编: ["add", "updateField", "status", "reorder"],
  演播室: ["status"],
  字幕: []
};

export const ACTION_LABEL: Record<ActionKind, string> = {
  add: "新增条目",
  updateField: "修改条目",
  status: "标记已播出",
  reorder: "调整顺序",
  skip: "取消条目",
  breaking: "突发插播"
};

export function canPerform(role: Role, action: ActionKind): boolean {
  return MATRIX[role]?.includes(action) ?? false;
}

export function denyReason(role: Role, action: ActionKind): string {
  if (canPerform(role, action)) return "";
  return role === "字幕"
    ? `字幕岗位无权修改串联单（${ACTION_LABEL[action]}已拒绝）`
    : role === "演播室"
      ? `演播室岗位只能标记已播出（${ACTION_LABEL[action]}已拒绝）`
      : `${role}岗位无权执行${ACTION_LABEL[action]}`;
}

/* ---------------- 旧数据升级 ---------------- */

export const SCHEMA_VERSION = 2;

export function migrateItem(raw: RundownItem, index = 0): RundownItem {
  const item: RundownItem = { ...raw };
  // 硬时间缺省归一
  if (item.hardStart === undefined || item.hardStart === "") delete item.hardStart;
  // 旧数据没有字段时间戳：以开播前的基线时间补齐，保证升级后继续可用——
  // 基线上的字段不应被视为“已有抢先编辑”，任何在直播期间发生的修改都能正常落地。
  const stamp = "2026-10-08T07:30:00.000Z";
  const editable: EditableField[] = ["title", "type", "duration", "presenter", "source"];
  if (item.hardStart) editable.push("hardStart");
  item.fieldTs = { ...item.fieldTs };
  item.fieldOwner = { ...item.fieldOwner };
  editable.forEach((field) => {
    if (!item.fieldTs![field]) {
      item.fieldTs![field] = stamp;
      // index 保留在 owner 上仅作调试，不影响合并
      void index;
    }
  });
  return item;
}

export function migrateSnapshot(raw: unknown): RundownItem[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RundownItem[]).map((entry, i) => migrateItem(entry, i));
}

/* ---------------- 字段级合并（先到优先，已播出锁定） ---------------- */

interface ApplyCtx {
  byId: Map<string, RundownItem>;
  order: string[];
  conflicts: MergeConflict[];
  changes: BreakingChange[];
}

/**
 * 判断一次字段编辑能否落地：
 * 1. 已播出条目不允许再改（播出状态锁）；
 * 2. 字段已有更早的他端编辑时，后到修改被拦下（先改优先）；
 *    同一终端对自己持有字段的继续修改允许落地。
 */
function fieldEditAllowed(ctx: ApplyCtx, op: Extract<QueuedOp, { type: "updateField" }>): RundownItem | undefined {
  const item = ctx.byId.get(op.itemId);
  if (!item) {
    ctx.conflicts.push({ opId: op.id, detail: op.itemId, reason: "条目不存在，修改丢弃" });
    return undefined;
  }
  if (item.status === "已播出") {
    ctx.conflicts.push({ opId: op.id, detail: item.title, reason: "条目已播出，字段锁定，后到修改不能覆盖" });
    return undefined;
  }
  const ts = item.fieldTs?.[op.field];
  const owner = item.fieldOwner?.[op.field];
  // 该字段已被他端抢先编辑（先改优先），后到修改被拦下；
  // 旧数据迁移字段没有 owner，首个直播期编辑允许抢占；
  // 同一终端对自己持有字段的继续修改也允许落地。
  if (owner && owner !== op.client && ts && op.at > ts) {
    ctx.conflicts.push({ opId: op.id, detail: item.title, reason: `「${op.field}」已被更早的修改抢先，后到修改被保留版本覆盖` });
    return undefined;
  }
  return item;
}

function applyOne(items: RundownItem[], changes: BreakingChange[], conflicts: MergeConflict[], op: QueuedOp): void {
  const ctx: ApplyCtx = { byId: new Map(items.map((i) => [i.id, i])), order: items.map((i) => i.id), conflicts, changes };

  switch (op.type) {
    case "add": {
      if (ctx.byId.has(op.item.id)) {
        conflicts.push({ opId: op.id, detail: op.item.title, reason: "新增条目已存在，重复提交被忽略" });
        return;
      }
      items.push(op.item);
      return;
    }
    case "updateField": {
      const item = fieldEditAllowed(ctx, op);
      if (!item) return;
      (item as unknown as Record<string, unknown>)[op.field] = op.value;
      item.fieldTs = { ...item.fieldTs, [op.field]: op.at };
      item.fieldOwner = { ...item.fieldOwner, [op.field]: op.client };
      return;
    }
    case "status": {
      const item = ctx.byId.get(op.itemId);
      if (!item) {
        conflicts.push({ opId: op.id, detail: op.itemId, reason: "条目不存在，状态操作丢弃" });
        return;
      }
      // 已播出状态任何后到操作都不能盖掉（取消/跳过同样无法回退）
      if (item.status === "已播出") {
        conflicts.push({ opId: op.id, detail: item.title, reason: "已播出状态锁定，后到状态修改被拒绝" });
        return;
      }
      item.status = "已播出" as ItemStatus;
      return;
    }
    case "skip": {
      const item = ctx.byId.get(op.itemId);
      if (!item) {
        conflicts.push({ opId: op.id, detail: op.itemId, reason: "条目不存在，取消操作丢弃" });
        return;
      }
      if (item.status === "已播出") {
        conflicts.push({ opId: op.id, detail: item.title, reason: "条目已播出，取消操作不能覆盖播出状态" });
        return;
      }
      item.status = "已跳过";
      return;
    }
    case "breaking": {
      if (ctx.byId.has(op.item.id)) {
        // 重复恢复：插播条目已经在单上，幂等跳过（突发记录也不重复追加）
        return;
      }
      const change = { ...op.change, id: op.id, client: op.client };
      const idx = ctx.order.indexOf(op.insertAfter);
      const newItem = op.item;
      if (idx === -1) {
        items.push(newItem);
        conflicts.push({ opId: op.id, detail: op.item.title, reason: "锚点条目已不存在，插播追加到串联单末尾" });
      } else {
        items.splice(idx + 1, 0, newItem);
      }
      if (!changes.some((c) => c.id === op.id)) changes.unshift(change);
      return;
    }
    case "reorder": {
      // 只提交尚未落地的顺序意图：按该操作给出的相对顺序排列已知条目，
      // 对方终端新增的条目（不在本次顺序快照里）保持相对位置追加在后。
      const known = new Set(op.orderedIds);
      const wanted = op.orderedIds.filter((id) => ctx.byId.has(id)).map((id) => ctx.byId.get(id)!);
      const extras = items.filter((i) => !known.has(i.id));
      items.splice(0, items.length, ...wanted, ...extras);
      return;
    }
  }
}

/**
 * 服务端/本地恢复的统一合并入口：
 * @param base      服务端当前权威串联单（或恢复时的本地单）
 * @param incoming  待提交的应急操作（按时间先后）
 * @param landedIds 已落地操作日志，用于“重复恢复不能重复插入”
 */
export function reconcile(base: RundownItem[], incoming: QueuedOp[], landedIds: string[], baseChanges: BreakingChange[] = []): MergeReport {
  const items = structuredClone(base);
  const changes = structuredClone(baseChanges);
  const preLanded = new Set(landedIds);
  const newLanded = new Set<string>();
  const conflicts: MergeConflict[] = [];
  const duplicateIds: string[] = [];
  const durationBefore = items.reduce((s, i) => s + i.duration, 0);

  for (const op of incoming) {
    if (preLanded.has(op.id)) {
      // 重复恢复：该操作此前已经提交落地过，直接去重，绝不重复插入
      duplicateIds.push(op.id);
      continue;
    }
    applyOne(items, changes, conflicts, op);
    // 无论成功落地还是被先改/已播出拦下，都登记幂等日志：
    // 重复恢复时既不会重复插入，也不会重复告警。
    newLanded.add(op.id);
  }

  const durationAfter = items.reduce((s, i) => s + i.duration, 0);
  return {
    items,
    changes,
    landed: [...newLanded],
    duplicateIds,
    conflicts,
    durationBefore,
    durationAfter,
    durationChanged: durationBefore !== durationAfter,
    at: new Date().toISOString()
  };
}

/* ---------------- 硬时间风险（合并后重算） ---------------- */

export interface RiskPoint {
  item: RundownItem;
  plannedAt: string;
}

/** 以 08:00 开播、逐条累加时长推算计划时间，超出硬时间即风险；合并后时长一变立即重新调用 */
export function computeRisks(items: RundownItem[], startMinutes = 8 * 60): { timeline: { item: RundownItem; at: Date }[]; risks: RiskPoint[] } {
  let cursor = startMinutes;
  const timeline = items.map((item) => {
    const atMin = cursor;
    cursor += item.duration;
    return { item, atMin };
  });
  const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const risks = timeline
    .filter(({ item }) => item.hardStart)
    .filter(({ item, atMin }) => atMin > toMinutes(item.hardStart!))
    .map(({ item, atMin }) => ({ item, plannedAt: fmt(atMin) }));
  return {
    timeline: timeline.map(({ item, atMin }) => ({ item, at: new Date(2026, 9, 8, Math.floor(atMin / 60), atMin % 60) })),
    risks
  };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
