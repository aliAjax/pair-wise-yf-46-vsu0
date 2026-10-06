import { useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button, InputNumber, Tag } from "antd";
import type { EditableField, RundownItem } from "../types";

interface Props {
  item: RundownItem;
  cumulative: string;
  canReorder: boolean;
  canEdit: boolean;
  canStatus: boolean;
  canSkip: boolean;
  onStatus: () => void;
  onSkip: () => void;
  onDuration: (delta: number) => void;
  onField: (field: EditableField, value: string | number) => void;
}

export function SortableItem({ item, cumulative, canReorder, canEdit, canStatus, canSkip, onStatus, onSkip, onDuration, onField }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: item.id, disabled: !canReorder });
  const [editing, setEditing] = useState(false);
  return (
    <article ref={setNodeRef} className={`rundown-row status-${item.status}`} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <button className="drag-handle" {...attributes} {...listeners} disabled={!canReorder} title={canReorder ? "拖动调整顺序" : "当前岗位/状态不可调序"}>⠿</button>
      <time>{cumulative}</time>
      <div className="row-main"><b>{item.title}</b><small>{item.source} · {item.presenter}{item.fieldOwner?.title ? ` · 持单：${item.fieldOwner.title.includes("主编") ? "主编台" : "导播台"}` : ""}</small></div>
      <Tag color={item.type === "广告" ? "gold" : item.type === "连线" ? "blue" : "geekblue"}>{item.type}</Tag>
      {editing && canEdit
        ? <InputNumber size="small" min={1} max={120} value={item.duration} addonAfter="分" onChange={(v) => v && onField("duration", Number(v))} onBlur={() => setEditing(false)} autoFocus />
        : <span className="duration-edit" onClick={() => canEdit && setEditing(true)} title={canEdit ? "点击直接改时长（先改优先）" : "当前岗位无权编辑"}>{item.duration} 分钟</span>}
      <Tag color={item.status === "已播出" ? "green" : item.status === "已跳过" ? "red" : "default"}>{item.status}</Tag>
      <div className="row-actions">
        <Button size="small" disabled={!canEdit} onClick={() => onDuration(-1)}>-1</Button>
        <Button size="small" disabled={!canEdit} onClick={() => onDuration(1)}>+1</Button>
        <Button size="small" type="primary" disabled={!canStatus || item.status === "已播出"} onClick={onStatus}>播出</Button>
        <Button size="small" danger disabled={!canSkip || item.status === "已播出"} onClick={onSkip}>取消</Button>
      </div>
    </article>
  );
}
