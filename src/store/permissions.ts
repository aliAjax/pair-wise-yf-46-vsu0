import type { Permission, Role } from "../types";

/**
 * 岗位权限矩阵。
 * 导播：编排台全部操作；主编：除调整顺序外的编排操作；字幕 / 演播室：只读，越权修改一律拒绝。
 */
export const PERMISSIONS: Record<Role, Permission[]> = {
  导播: ["add", "duration", "status", "skip", "breaking", "reorder", "undo"],
  主编: ["add", "duration", "status", "skip", "breaking", "undo"],
  字幕: [],
  演播室: []
};

export const PERMISSION_LABELS: Record<Permission, string> = {
  add: "新增条目",
  duration: "调整时长",
  status: "播出状态",
  skip: "取消条目",
  breaking: "突发插播",
  reorder: "调整顺序",
  undo: "撤回上一步"
};

export const ROLES: Role[] = ["导播", "主编", "字幕", "演播室"];

export function can(role: Role, permission: Permission): boolean {
  return PERMISSIONS[role].includes(permission);
}
