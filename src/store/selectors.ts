import { createSelector } from "@reduxjs/toolkit";
import { addMinutes, format } from "date-fns";
import type { RundownItem } from "../types";
import type { RootState } from "./index";

const SHOW_START = new Date("2026-10-08T08:00:00");

export interface TimelineEntry {
  item: RundownItem;
  at: string;
  duration: number;
}

/** 串联单时间线：纯派生，条目或时长变化后自动重算 */
export const selectTimeline = createSelector(
  [(state: RootState) => state.rundown.items],
  (items): TimelineEntry[] => {
    let cursor = SHOW_START;
    return items.map((item) => {
      const at = format(cursor, "HH:mm");
      cursor = addMinutes(cursor, item.duration);
      return { item, at, duration: item.duration };
    });
  }
);

/**
 * 硬时间风险：纯派生选择器。
 * 合并 / 回放导致时长变化后，原风险立即失效并按最新条目重新计算，不缓存旧结果。
 */
export const selectRisks = createSelector(
  [selectTimeline],
  (timeline): TimelineEntry[] => timeline.filter(({ item, at }) => Boolean(item.hardStart) && at > (item.hardStart as string))
);

export const selectPendingCount = createSelector(
  [(state: RootState) => state.rundown.queue],
  (queue): number => queue.filter((item) => item.status === "pending").length
);
