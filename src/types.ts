export type Role = "导播" | "主编" | "字幕" | "演播室";
export type ItemType = "新闻片" | "连线" | "嘉宾" | "口播" | "广告";
export type ItemStatus = "待播" | "已播出" | "已跳过" | "草稿";
export type Permission = "add" | "duration" | "status" | "skip" | "breaking" | "reorder" | "undo";

export interface RundownItem {
  id: string;
  title: string;
  type: ItemType;
  duration: number;
  hardStart?: string;
  status: ItemStatus;
  presenter: string;
  source: string;
  /** 乐观并发版本号：每次被任一终端修改 +1，用于先写者赢冲突检测 */
  version: number;
  /** 最后修改岗位（终端） */
  updatedBy?: Role | "对端终端";
  /** 幂等键：由哪个排队操作创建，重复恢复不重复插入 */
  createdByOp?: string;
}

export interface BreakingChange {
  id: string;
  headline: string;
  duration: number;
  insertAfter: string;
  reason: string;
  createdAt: string;
}

export type QueueStatus = "pending" | "landed" | "rejected";

export interface PendingChange {
  id: string;
  /** 操作幂等键，恢复时据此去重 */
  opId: string;
  action: string;
  detail: string;
  queuedAt: string;
  /** 操作基于的条目版本（整单最大版本） */
  baseVersion: number;
  /** 操作影响的字段，用于冲突判定 */
  field?: string;
  /** 操作载荷，恢复时回放 */
  payload: unknown;
  status: QueueStatus;
  reason?: string;
  landedAt?: string;
}

export interface OpOutcome {
  opId: string;
  status: QueueStatus;
  reason?: string;
}

export interface MergeResult {
  items: RundownItem[];
  outcomes: OpOutcome[];
}

export interface HistoryEntry {
  id: string;
  label: string;
  detail: string;
  time: string;
  snapshot: RundownItem[];
}
