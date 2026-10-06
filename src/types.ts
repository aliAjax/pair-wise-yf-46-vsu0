export type Role = "导播" | "主编" | "字幕" | "演播室";
export type ItemType = "新闻片" | "连线" | "嘉宾" | "口播" | "广告";
export type ItemStatus = "待播" | "已播出" | "已跳过" | "草稿";

/** 参与“先改优先”字段级合并的可编辑字段 */
export type EditableField = "title" | "type" | "duration" | "hardStart" | "presenter" | "source";

export interface RundownItem {
  id: string;
  title: string;
  type: ItemType;
  duration: number;
  hardStart?: string;
  status: ItemStatus;
  presenter: string;
  source: string;
  /** 各字段最近一次“抢先编辑”的时间戳，旧数据升级时补齐 */
  fieldTs?: Partial<Record<EditableField, string>>;
  /** 各字段的当前持有者（终端），同一终端的后续修改允许覆盖自己 */
  fieldOwner?: Partial<Record<EditableField, string>>;
}

export interface BreakingChange {
  id: string;
  headline: string;
  duration: number;
  insertAfter: string;
  reason: string;
  createdAt: string;
  client?: string;
}

/** 结构化应急操作：断网期间所有排片动作都落成可幂等重放的 op */
export interface QueuedOpBase {
  id: string;
  at: string;
  client: string;
  role: Role;
}

export type QueuedOp = QueuedOpBase & (
  | { type: "add"; item: RundownItem }
  | { type: "updateField"; itemId: string; field: EditableField; value: string | number }
  | { type: "status"; itemId: string; status: "已播出" }
  | { type: "reorder"; orderedIds: string[] }
  | { type: "skip"; itemId: string }
  | { type: "breaking"; item: RundownItem; insertAfter: string; change: BreakingChange }
);

export type OpType = QueuedOp["type"];

export interface MergeConflict {
  opId: string;
  detail: string;
  reason: string;
}

export interface MergeReport {
  items: RundownItem[];
  changes: BreakingChange[];
  /** 成功落地的操作 */
  landed: string[];
  /** 重复恢复时被幂等去重的操作 */
  duplicateIds: string[];
  /** 被“先到修改 / 已播出锁定”拦下的操作 */
  conflicts: MergeConflict[];
  durationBefore: number;
  durationAfter: number;
  /** 合并后总时长一旦变化，原硬时间风险立即失效并重算 */
  durationChanged: boolean;
  at: string;
}

export interface Denial {
  id: string;
  action: string;
  reason: string;
  at: string;
}

export interface HistoryEntry {
  id: string;
  label: string;
  detail: string;
  time: string;
  snapshot: RundownItem[];
}

export interface TerminalPrefs {
  role: Role;
  online: boolean;
}
