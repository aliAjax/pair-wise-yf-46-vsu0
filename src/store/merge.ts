import type { ItemType, MergeResult, PendingChange, Role, RundownItem } from "../types";

export const RUNDOWN_KEY = "pair-wise-yf-46/rundown";

/** 旧数据升级：补齐乐观并发版本号，其余字段保持可用 */
export function migrateItems(raw: unknown): RundownItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const item = entry as Partial<RundownItem>;
    return { ...item, version: typeof item.version === "number" ? item.version : 1 } as RundownItem;
  });
}

export function loadItems(storage: Storage = localStorage): RundownItem[] {
  try {
    return migrateItems(JSON.parse(storage.getItem(RUNDOWN_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

export function saveItems(items: RundownItem[], storage: Storage = localStorage): void {
  storage.setItem(RUNDOWN_KEY, JSON.stringify(items));
}

/**
 * 合并冲突判定（基于恢复开始时的快照）：
 * - 已播出状态不可覆盖（优先级最高）：对端已播出的条目，状态 / 跳过 / 时长修改一律拒绝
 * - 先写者赢：恢复开始时条目版本 > 操作基于的版本，说明对端终端已先改，后到修改拒绝
 */
export function conflictReason(
  item: RundownItem,
  startVersion: number,
  baseVersion: number,
  field: string,
  startStatus: RundownItem["status"]
): string | null {
  if (startStatus === "已播出" && (field === "status" || field === "skip" || field === "duration")) {
    return `条目「${item.title}」已播出，已播出状态不可覆盖`;
  }
  if (startVersion > baseVersion) {
    return `条目「${item.title}」已被其他终端先修改（当前 v${startVersion}，本次基于 v${baseVersion}），后到修改被拒绝`;
  }
  return null;
}

/**
 * 断网应急队列恢复合并（纯函数）。
 * 只回放 status=pending 的操作；已落地 / 已拒绝的操作直接跳过，重复恢复不重复插入。
 */
export function mergeQueue(baseItems: RundownItem[], ops: PendingChange[]): MergeResult {
  const items = structuredClone(baseItems);
  const startVersions = new Map(items.map((item) => [item.id, item.version]));
  const startStatus = new Map(items.map((item) => [item.id, item.status]));
  const outcomes: MergeResult["outcomes"] = [];

  for (const op of ops) {
    if (op.status !== "pending") continue; // 幂等：已结束的操作不再回放
    try {
      switch (op.action) {
        case "新增条目": {
          const payload = op.payload as { title: string; type: ItemType; duration: number; presenter: string; source: string; role?: Role };
          if (items.some((item) => item.createdByOp === op.opId)) {
            outcomes.push({ opId: op.opId, status: "landed", reason: "重复恢复，已跳过" });
            break;
          }
          const { role: _role, ...fields } = payload;
          items.push({ ...fields, id: crypto.randomUUID(), status: "草稿", version: 1, createdByOp: op.opId, updatedBy: payload.role });
          outcomes.push({ opId: op.opId, status: "landed" });
          break;
        }
        case "突发插播": {
          const payload = op.payload as { headline: string; duration: number; insertAfter: string; reason: string; role?: Role };
          if (items.some((item) => item.createdByOp === op.opId)) {
            outcomes.push({ opId: op.opId, status: "landed", reason: "重复恢复，已跳过" });
            break;
          }
          const index = items.findIndex((item) => item.id === payload.insertAfter);
          if (index < 0) throw new Error("插入位置条目不存在，可能已被其他终端删除");
          items.splice(index + 1, 0, {
            id: crypto.randomUUID(),
            title: payload.headline,
            type: "新闻片",
            duration: payload.duration,
            status: "待播",
            presenter: "值班主播",
            source: `插播：${payload.reason}`,
            version: 1,
            createdByOp: op.opId,
            updatedBy: payload.role
          });
          outcomes.push({ opId: op.opId, status: "landed" });
          break;
        }
        case "调整顺序": {
          const payload = op.payload as { orderedIds: string[]; role?: Role };
          const startMax = startVersions.size ? Math.max(...startVersions.values()) : 1;
          if (startMax > op.baseVersion) {
            throw new Error(`串联单已被其他终端修改（最新 v${startMax}，本次基于 v${op.baseVersion}），顺序调整被拒绝`);
          }
          const map = new Map(items.map((item) => [item.id, item]));
          const reordered = payload.orderedIds.map((id) => map.get(id)).filter((item): item is RundownItem => Boolean(item));
          if (reordered.length !== items.length) throw new Error("顺序调整期间条目数量发生变化，拒绝覆盖");
          items.splice(0, items.length, ...reordered);
          for (const item of items) item.version += 1; // 顺序变化影响累计时间与位置，整单版本 +1
          outcomes.push({ opId: op.opId, status: "landed" });
          break;
        }
        case "调整时长": {
          const payload = op.payload as { id: string; delta: number; role?: Role };
          const item = items.find((entry) => entry.id === payload.id);
          if (!item) throw new Error("条目不存在，可能已被其他终端删除");
          const reason = conflictReason(item, startVersions.get(item.id) ?? 1, op.baseVersion, "duration", startStatus.get(item.id) ?? "待播");
          if (reason) throw new Error(reason);
          item.duration = Math.max(1, item.duration + payload.delta);
          item.version += 1;
          item.updatedBy = payload.role ?? item.updatedBy;
          outcomes.push({ opId: op.opId, status: "landed" });
          break;
        }
        case "播出状态":
        case "取消条目": {
          const payload = op.payload as { id: string; status?: RundownItem["status"]; role?: Role };
          const item = items.find((entry) => entry.id === payload.id);
          if (!item) throw new Error("条目不存在，可能已被其他终端删除");
          const reason = conflictReason(item, startVersions.get(item.id) ?? 1, op.baseVersion, "status", startStatus.get(item.id) ?? "待播");
          if (reason) throw new Error(reason);
          item.status = op.action === "取消条目" ? "已跳过" : (payload.status ?? item.status);
          item.version += 1;
          item.updatedBy = payload.role ?? item.updatedBy;
          outcomes.push({ opId: op.opId, status: "landed" });
          break;
        }
        default:
          throw new Error(`未知操作类型 ${op.action}`);
      }
    } catch (err) {
      outcomes.push({ opId: op.opId, status: "rejected", reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { items, outcomes };
}
