import { createApi, fakeBaseQuery } from "@reduxjs/toolkit/query/react";
import type { MergeResult, PendingChange, RundownItem } from "../types";
import { loadItems, mergeQueue, RUNDOWN_KEY, saveItems } from "./merge";

export const rundownApi = createApi({
  reducerPath: "rundownApi",
  baseQuery: fakeBaseQuery(),
  tagTypes: ["Rundown"],
  endpoints: (builder) => ({
    getRundown: builder.query<RundownItem[], void>({
      queryFn: async () => ({ data: loadItems() }),
      providesTags: ["Rundown"]
    }),
    saveRundown: builder.mutation<{ ok: true }, RundownItem[]>({
      queryFn: async (items) => {
        saveItems(items);
        return { data: { ok: true } };
      },
      invalidatesTags: ["Rundown"]
    }),
    /** 模拟对端终端在断网期间抢先修改 / 播出某条目，用于验证合并冲突 */
    simulatePeerEdit: builder.mutation<{ ok: true }, { id: string; markAired?: boolean }>({
      queryFn: async ({ id, markAired }) => {
        const items = loadItems();
        const item = items.find((entry) => entry.id === id);
        if (item) {
          if (markAired) item.status = "已播出";
          item.version += 1;
          item.updatedBy = "对端终端";
          saveItems(items);
        }
        return { data: { ok: true } };
      },
      invalidatesTags: ["Rundown"]
    }),
    /**
     * 断网应急队列恢复合并。
     * 只回放 status=pending 的操作；已落地 / 已拒绝的操作直接跳过，重复恢复不重复插入。
     */
    mergeQueue: builder.mutation<MergeResult, PendingChange[]>({
      queryFn: async (ops) => {
        const result = mergeQueue(loadItems(), ops);
        saveItems(result.items);
        return { data: result };
      }
    })
  })
});

export const {
  useGetRundownQuery,
  useSaveRundownMutation,
  useSimulatePeerEditMutation
} = rundownApi;

export { RUNDOWN_KEY };
