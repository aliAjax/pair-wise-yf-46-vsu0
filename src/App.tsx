import { useCallback, useEffect, useRef, useState } from "react";
import { useDispatch } from "react-redux";
import type { AppDispatch } from "./store";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Button, Card, Form, Input, InputNumber, Popover, Select, Switch, Tag, Timeline, message } from "antd";
import { format } from "date-fns";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes } from "react-router-dom";
import { SortableItem } from "./components/SortableItem";
import { rundownApi, useGetRundownQuery, useSaveRundownMutation, useSimulatePeerEditMutation } from "./store/api";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import {
  addItem, adjustDuration, clearFinished, deny, initialize, insertBreaking,
  reorder, setItems, setOnline, setRole, skipItem, syncOfflineQueue, undo, updateStatus
} from "./store/rundownSlice";
import { selectPendingCount, selectRisks, selectTimeline } from "./store/selectors";
import { can, PERMISSION_LABELS, PERMISSIONS, ROLES } from "./store/permissions";
import type { MergeResult, Permission, Role, RundownItem } from "./types";

const QUEUE_KEY = "pair-wise-yf-46/queue";

const schema = z.object({ title: z.string().min(2), type: z.enum(["新闻片", "连线", "嘉宾", "口播", "广告"]), duration: z.number().min(1).max(120), presenter: z.string().min(1), source: z.string().min(1) });
type FormValues = z.infer<typeof schema>;

function useGuard() {
  const dispatch = useAppDispatch();
  const role = useAppSelector((state) => state.rundown.role);
  return useCallback((permission: Permission, label: string): boolean => {
    if (can(role, permission)) return true;
    message.error(`越权拒绝：${role} 岗位无权「${label}」`);
    dispatch(deny({ permission, label }));
    return false;
  }, [dispatch, role]);
}

function useSyncQueue() {
  const dispatch = useAppDispatch();
  return useCallback(async () => {
    const result = await dispatch(syncOfflineQueue()).unwrap();
    if ("skipped" in result) {
      message.info("没有待提交的操作");
      return;
    }
    const landed = result.outcomes.filter((outcome) => outcome.status === "landed").length;
    const rejected = result.outcomes.filter((outcome) => outcome.status === "rejected");
    if (rejected.length) {
      message.warning(`应急队列已提交：${landed} 项落地，${rejected.length} 项被拒绝（${rejected[0].reason}）`);
    } else {
      message.success(`应急队列已提交，${landed} 项操作落地`);
    }
  }, [dispatch]);
}

function PermissionsPopover() {
  const role = useAppSelector((state) => state.rundown.role);
  return (
    <Popover title="岗位权限矩阵（越权修改将被拒绝并记审计）" content={<div className="perm-matrix">
      {ROLES.map((entry) => (
        <div key={entry} className={entry === role ? "perm-row active" : "perm-row"}>
          <b>{entry}</b>
          <span>{PERMISSIONS[entry].length ? PERMISSIONS[entry].map((permission) => PERMISSION_LABELS[permission]).join("、") : "只读，无修改权"}</span>
        </div>
      ))}
    </div>}>
      <Button size="small">岗位权限</Button>
    </Popover>
  );
}

function RundownPage() {
  const dispatch = useAppDispatch();
  const { items, role, online, initialized } = useAppSelector((state) => state.rundown);
  const timeline = useAppSelector(selectTimeline);
  const risks = useAppSelector(selectRisks);
  const pendingCount = useAppSelector(selectPendingCount);
  const riskIds = new Set(risks.map((entry) => entry.item.id));
  const total = items.reduce((sum, item) => sum + item.duration, 0);
  const [saveMutation] = useSaveRundownMutation();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const guard = useGuard();
  const { control, handleSubmit, reset } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { title: "", type: "新闻片", duration: 5, presenter: "陈默", source: "主控" } });

  // 仅在线且无未落地排队操作时持久化到权威副本；断网期间的本地修改走应急队列，恢复时合并，避免重复插入或覆盖对端版本
  useEffect(() => {
    if (!online || !initialized || pendingCount > 0) return;
    const timer = setTimeout(() => { void saveMutation(items); }, 250);
    return () => clearTimeout(timer);
  }, [items, online, initialized, pendingCount, saveMutation]);

  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    if (!guard("reorder", "调整顺序")) return;
    const oldIndex = items.findIndex((item) => item.id === event.active.id);
    const newIndex = items.findIndex((item) => item.id === event.over!.id);
    dispatch(reorder(arrayMove(items, oldIndex, newIndex)));
  };

  const submit = (values: FormValues) => {
    if (!guard("add", "新增条目")) return;
    dispatch(addItem(values));
    reset();
  };

  return <div className="page-grid">
    <Card className="main-card">
      <div className="card-heading"><div><small>2026-10-08 · 08:00 开播</small><h2>直播串联单</h2></div><div className="head-actions"><Tag color={online ? "green" : "red"}>{online ? "主备链路正常" : "本地应急模式"}</Tag><Button onClick={() => { if (guard("undo", "撤回上一步")) dispatch(undo()); }}>撤回上一步</Button></div></div>
      <div className="summary"><span><b>{items.length}</b> 条内容</span><span><b>{total}</b> 分钟总时长</span><span className={risks.length ? "danger-text" : ""}><b>{risks.length}</b> 个硬时间风险</span><span><b>{timeline.at(-1)?.at ?? "--:--"}</b> 预计收播</span></div>
      {!online && <div className="offline-banner">本地应急模式：突发插播、取消、顺序调整等操作将进入应急队列，恢复后只提交尚未落地的操作；已播出状态不可被后到修改覆盖。</div>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
          <div className="rundown-list">{timeline.map(({ item, at }) => (
            <SortableItem
              key={item.id}
              item={item}
              cumulative={at}
              risk={riskIds.has(item.id)}
              onDuration={(delta) => { if (guard("duration", "调整时长")) dispatch(adjustDuration({ id: item.id, delta })); }}
              onStatus={() => { if (guard("status", "播出状态")) dispatch(updateStatus({ id: item.id, status: "已播出" })); }}
              onSkip={() => { if (guard("skip", "取消条目")) dispatch(skipItem(item.id)); }}
            />
          ))}</div>
        </SortableContext>
      </DndContext>
    </Card>
    <aside className="side-stack">
      <Card title="新增播出条目">
        <Form layout="vertical" onFinish={handleSubmit(submit)}>
          <Form.Item label="标题"><Controller name="title" control={control} render={({ field, fieldState }) => <><Input {...field} status={fieldState.error ? "error" : ""} /><small className="error">{fieldState.error?.message}</small></>} /></Form.Item>
          <div className="two-cols"><Form.Item label="类型"><Controller name="type" control={control} render={({ field }) => <Select {...field} options={["新闻片", "连线", "嘉宾", "口播", "广告"].map((v) => ({ value: v, label: v }))} />} /></Form.Item><Form.Item label="时长"><Controller name="duration" control={control} render={({ field }) => <InputNumber {...field} min={1} max={120} addonAfter="分钟" />} /></Form.Item></div>
          <Form.Item label="主播"><Controller name="presenter" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
          <Form.Item label="来源"><Controller name="source" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
          <Button htmlType="submit" type="primary" block>加入串联单</Button>
        </Form>
      </Card>
      <BreakingForm />
    </aside>
  </div>;
}

function BreakingForm() {
  const dispatch = useAppDispatch();
  const items = useAppSelector((state) => state.rundown.items);
  const online = useAppSelector((state) => state.rundown.online);
  const guard = useGuard();
  const [values, setValues] = useState({ headline: "", duration: 5, insertAfter: items[0]?.id ?? "", reason: "突发新闻" });
  const submit = () => {
    if (values.headline.length < 2) return;
    if (!guard("breaking", "突发插播")) return;
    dispatch(insertBreaking(values));
    message.success("突发插播已加入串联单，时长已重算");
    setValues({ ...values, headline: "" });
  };
  return <Card title="突发插播" className="breaking-card">
    <Input value={values.headline} onChange={(event) => setValues({ ...values, headline: event.target.value })} placeholder="插播标题" />
    <div className="two-cols"><InputNumber value={values.duration} onChange={(value) => setValues({ ...values, duration: Number(value ?? 5) })} addonAfter="分钟" /><Select value={values.insertAfter} onChange={(value) => setValues({ ...values, insertAfter: value })} options={items.map((item) => ({ value: item.id, label: `插在「${item.title}」后` }))} /></div>
    <Input value={values.reason} onChange={(event) => setValues({ ...values, reason: event.target.value })} placeholder="插播原因" />
    <Button type="primary" danger block disabled={values.headline.length < 2} onClick={submit}>立即插入并重算时长</Button>
    {!online && <small>离线操作将在主链路恢复后统一提交，当前顺序仍可用于本地播出。</small>}
  </Card>;
}

/** 对端终端模拟：断网期间另一台终端抢先修改 / 播出，用于验证合并冲突与已播出保护 */
function PeerSimulator() {
  const dispatch = useAppDispatch();
  const items = useAppSelector((state) => state.rundown.items);
  const [simulate] = useSimulatePeerEditMutation();
  const run = async (id: string, markAired: boolean) => {
    await simulate({ id, markAired }).unwrap();
    const fresh = await dispatch(rundownApi.endpoints.getRundown.initiate(undefined, { forceRefetch: true })).unwrap();
    dispatch(setItems(fresh));
    message.info(markAired ? "已模拟对端终端把该条目标记为已播出" : "已模拟对端终端抢先修改该条目（版本 +1）");
  };
  return <Card title="对端终端（模拟）" size="small">
    <p>断网期间，另一台终端可能已抢先修改或播出。恢复合并时将触发先写者赢与已播出状态保护。</p>
    <div className="peer-list">{items.map((item) => (
      <article key={item.id}><b>{item.title}</b><small>v{item.version} · {item.status}</small>
        <Button size="small" onClick={() => run(item.id, false)}>对端已修改</Button>
        <Button size="small" onClick={() => run(item.id, true)}>对端已播出</Button>
      </article>
    ))}</div>
  </Card>;
}

function QueuePage() {
  const dispatch = useAppDispatch();
  const queue = useAppSelector((state) => state.rundown.queue);
  const online = useAppSelector((state) => state.rundown.online);
  const [syncing, setSyncing] = useState(false);
  const runSync = useSyncQueue();
  const pending = queue.filter((item) => item.status === "pending").length;
  const onSync = async () => { setSyncing(true); try { await runSync(); } finally { setSyncing(false); } };
  return <div className="side-stack">
    <Card title="本地应急队列">
      <div className="queue-list">{queue.length ? [...queue].reverse().map((item) => (
        <article key={item.id}>
          <Tag color={item.status === "pending" ? "blue" : item.status === "landed" ? "green" : "red"}>{item.action}</Tag>
          <b>{item.detail}</b>
          <small>{format(new Date(item.queuedAt), "HH:mm:ss")} · {item.status === "pending" ? "待提交" : item.status === "landed" ? "已落地" : "已拒绝"}{item.reason ? ` · ${item.reason}` : ""}</small>
        </article>
      )) : <p>应急队列为空。断网期间的突发插播、取消、顺序调整等操作将在此排队，恢复后只提交尚未落地的操作；重复恢复不会重复插入。</p>}</div>
      <div className="queue-actions">
        <Button type="primary" loading={syncing} disabled={pending === 0} onClick={onSync}>提交待同步操作{pending ? `（${pending}）` : ""}</Button>
        <Button disabled={!queue.some((item) => item.status !== "pending")} onClick={() => dispatch(clearFinished())}>清除已结束</Button>
      </div>
    </Card>
    {!online && <PeerSimulator />}
  </div>;
}

function ChainPage({ mode }: { mode: "changes" | "queue" | "history" }) {
  const state = useAppSelector((root) => root.rundown);
  if (mode === "queue") return <QueuePage />;
  if (mode === "changes") return <Card title="突发变更记录"><Timeline items={state.changes.map((item) => ({ children: <div><b>{item.headline}</b><p>{item.reason} · 插播 {item.duration} 分钟</p><small>{format(new Date(item.createdAt), "HH:mm:ss")}</small></div> }))} /></Card>;
  return <Card title="操作历史"><Timeline items={state.history.map((entry) => ({ color: entry.label === "越权拒绝" ? "red" : "blue", children: <div><b>{entry.label}</b><p>{entry.detail}</p><small>{format(new Date(entry.time), "HH:mm:ss")}</small></div> }))} /></Card>;
}

export default function App() {
  const dispatch = useAppDispatch<AppDispatch>();
  const state = useAppSelector((root) => root.rundown);
  const pendingCount = useAppSelector(selectPendingCount);
  const { data = [], isSuccess } = useGetRundownQuery();
  const { t, i18n } = useTranslation();
  const runSync = useSyncQueue();
  const prevOnline = useRef(state.online);

  // 旧数据升级后继续可用：条目补版本号，旧队列条目标记升级
  useEffect(() => {
    if (!isSuccess) return;
    let queue: unknown = [];
    try { queue = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]"); } catch { /* 忽略损坏的本地队列 */ }
    dispatch(initialize({ items: data as RundownItem[], queue }));
  }, [isSuccess, data, dispatch]);

  // 队列持久化：断网恢复后队列仍在，重复恢复不重复插入
  useEffect(() => {
    if (state.initialized) localStorage.setItem(QUEUE_KEY, JSON.stringify(state.queue));
  }, [state.queue, state.initialized]);

  // 断网恢复（offline -> online）自动合并：只提交尚未落地的操作
  useEffect(() => {
    const recovered = prevOnline.current === false && state.online === true;
    prevOnline.current = state.online;
    if (recovered) void runSync();
  }, [state.online, runSync]);

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span>LIVE</span><div><b>{t("title")}</b><small>Control room</small></div></div><nav><NavLink to="/">{t("rundown")}</NavLink><NavLink to="/changes">{t("changes")}</NavLink><NavLink to="/queue">{t("queue")} {pendingCount ? <em>{pendingCount}</em> : null}</NavLink><NavLink to="/history">操作历史</NavLink></nav><Button ghost onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>{i18n.language === "zh" ? "EN" : "中文"}</Button></aside>
    <main><header className="topbar"><div><small>直播运行中 · 紧急操作均保留审计记录</small><h1>{t("title")}</h1></div><div className="top-actions"><label>在线模式 <Switch checked={state.online} onChange={(value) => dispatch(setOnline(value))} /></label><label>当前岗位 <Select<Role> value={state.role} onChange={(value) => dispatch(setRole(value))} options={ROLES.map((role) => ({ value: role }))} /></label><PermissionsPopover /></div></header><Routes><Route path="/" element={<RundownPage />} /><Route path="/changes" element={<ChainPage mode="changes" />} /><Route path="/queue" element={<ChainPage mode="queue" />} /><Route path="/history" element={<ChainPage mode="history" />} /></Routes></main>
  </div>;
}
