import { useEffect, useMemo, useRef, useState } from "react";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Alert, Button, Card, Form, Input, InputNumber, Select, Switch, Tag, Timeline, message } from "antd";
import { format } from "date-fns";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes } from "react-router-dom";
import { SortableItem } from "./components/SortableItem";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import {
  acknowledgeDenial, addItem, adjustDuration, bootstrap, insertBreaking, pullServer, reorder,
  recoverQueue, seedPeer, setOnline, setRole, skipItem, switchClient, undo, updateField, updateStatus
} from "./store/rundownSlice";
import { canPerform, computeRisks } from "./app/collab";
import { loadClient, saveClient, TERMINALS } from "./app/clientStore";
import { loadServer } from "./app/server";
import type { EditableField, QueuedOp, Role, RundownItem } from "./types";

const schema = z.object({ title: z.string().min(2), type: z.enum(["新闻片", "连线", "嘉宾", "口播", "广告"]), duration: z.number().min(1).max(120), presenter: z.string().min(1), source: z.string().min(1) });
type FormValues = z.infer<typeof schema>;

const FIELD_LABEL: Record<EditableField, string> = { title: "标题", type: "类型", duration: "时长", hardStart: "硬时间", presenter: "主播", source: "来源" };

export function opSummary(op: QueuedOp, items: RundownItem[]): { tag: string; detail: string } {
  const titleOf = (id: string) => items.find((i) => i.id === id)?.title ?? id;
  switch (op.type) {
    case "add": return { tag: "新增条目", detail: op.item.title };
    case "updateField": return { tag: "修改条目", detail: `${titleOf(op.itemId)} · ${FIELD_LABEL[op.field]} → ${op.value}` };
    case "status": return { tag: "标记已播出", detail: titleOf(op.itemId) };
    case "reorder": return { tag: "调整顺序", detail: `按 ${op.orderedIds.length} 个条目重排` };
    case "skip": return { tag: "取消条目", detail: titleOf(op.itemId) };
    case "breaking": return { tag: "突发插播", detail: op.item.title };
  }
}

function RundownPage() {
  const dispatch = useAppDispatch();
  const { items, role, online, riskEpoch } = useAppSelector((state) => state.rundown);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const { timeline, risks } = useMemo(() => computeRisks(items), [items]);
  const total = items.reduce((sum, item) => sum + item.duration, 0);
  const at = (d: Date) => format(d, "HH:mm");
  const { control, handleSubmit, reset } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { title: "", type: "新闻片", duration: 5, presenter: "陈默", source: "主控" } });

  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    const oldIndex = items.findIndex((item) => item.id === event.active.id);
    const newIndex = items.findIndex((item) => item.id === event.over!.id);
    dispatch(reorder(arrayMove(items, oldIndex, newIndex)));
  };

  const submit = (values: FormValues) => {
    dispatch(addItem(values));
    reset();
  };

  return <div className="page-grid">
    <Card className="main-card">
      <div className="card-heading"><div><small>2026-10-08 · 08:00 开播</small><h2>直播串联单</h2></div><div className="head-actions"><Tag color={online ? "green" : "red"}>{online ? "主备链路正常" : "本地应急模式"}</Tag><Button onClick={() => dispatch(undo())} disabled={role === "字幕" || role === "演播室"}>撤回上一步</Button></div></div>
      <div className="summary"><span><b>{items.length}</b> 条内容</span><span><b>{total}</b> 分钟总时长</span><span className={risks.length ? "danger-text" : ""}><b>{risks.length}</b> 个硬时间风险 <em className="epoch-tag">第 {riskEpoch + 1} 轮</em></span><span><b>{timeline.at(-1) ? at(timeline.at(-1)!.at) : "--:--"}</b> 预计收播</span></div>
      {risks.length > 0 && <Alert className="risk-alert" type="error" showIcon message="硬时间风险" description={risks.map((r) => `「${r.item.title}」计划 ${r.plannedAt}，晚于硬时间 ${r.item.hardStart}`).join("；")} />}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
          <div className="rundown-list">{timeline.map(({ item, at: when }) => <SortableItem key={item.id} item={item} cumulative={at(when)} canReorder={canPerform(role, "reorder") && item.status !== "已播出"} canEdit={canPerform(role, "updateField") && item.status !== "已播出"} canStatus={canPerform(role, "status")} canSkip={canPerform(role, "skip") && item.status !== "已播出"} onDuration={(delta) => dispatch(adjustDuration({ id: item.id, delta }))} onField={(field, value) => dispatch(updateField({ id: item.id, field, value }))} onStatus={() => dispatch(updateStatus({ id: item.id, status: "已播出" }))} onSkip={() => dispatch(skipItem(item.id))} />)}</div>
        </SortableContext>
      </DndContext>
    </Card>
    <aside className="side-stack">
      <Card title="新增播出条目">
        <Form layout="vertical" onFinish={handleSubmit(submit)}>
          <Form.Item label="标题"><Controller name="title" control={control} render={({ field, fieldState }) => <><Input {...field} status={fieldState.error ? "error" : ""} /><small className="error">{fieldState.error?.message}</small></>} /></Form.Item>
          <div className="two-cols"><Form.Item label="类型"><Controller name="type" control={control} render={({ field }) => <Select {...field} options={["新闻片","连线","嘉宾","口播","广告"].map((v) => ({ value: v, label: v }))} />} /></Form.Item><Form.Item label="时长"><Controller name="duration" control={control} render={({ field }) => <InputNumber {...field} min={1} max={120} addonAfter="分钟" />} /></Form.Item></div>
          <Form.Item label="主播"><Controller name="presenter" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
          <Form.Item label="来源"><Controller name="source" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
          <Button htmlType="submit" type="primary" block disabled={!canPerform(role, "add")}>加入串联单</Button>
        </Form>
      </Card>
      <BreakingForm canBreak={canPerform(role, "breaking")} />
    </aside>
  </div>;
}

function BreakingForm({ canBreak }: { canBreak: boolean }) {
  const dispatch = useAppDispatch();
  const { items, online } = useAppSelector((state) => state.rundown);
  const [values, setValues] = useState({ headline: "", duration: 5, insertAfter: items[0]?.id ?? "", reason: "突发新闻" });
  return <Card title="突发插播" className="breaking-card">
    <Input value={values.headline} onChange={(event) => setValues({ ...values, headline: event.target.value })} placeholder="插播标题" disabled={!canBreak} />
    <div className="two-cols"><InputNumber value={values.duration} onChange={(value) => setValues({ ...values, duration: Number(value ?? 5) })} addonAfter="分钟" disabled={!canBreak} /><Select value={values.insertAfter} onChange={(value) => setValues({ ...values, insertAfter: value })} options={items.map((item) => ({ value: item.id, label: `插在「${item.title}」后` }))} disabled={!canBreak} /></div>
    <Input value={values.reason} onChange={(event) => setValues({ ...values, reason: event.target.value })} placeholder="插播原因" disabled={!canBreak} />
    <Button type="primary" danger block disabled={!canBreak || values.headline.length < 2} onClick={() => { dispatch(insertBreaking(values)); if (!online) message.warning("突发插播已进入应急队列，恢复时只提交尚未落地的操作"); setValues({ ...values, headline: "" }); }}>立即插入并重算时长</Button>
    {!online && <small>离线操作将在主链路恢复后统一提交，当前顺序仍可用于本地播出。</small>}
    {!canBreak && <small className="muted-note">仅导播岗位可执行突发插播，越权操作会被拒绝并记录。</small>}
  </Card>;
}

function QueuePage() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.rundown);
  const merge = state.lastMerge;
  return <div className="chain-grid">
    <Card title="本地应急队列">
      <div className="queue-list">{state.queue.length ? state.queue.map((op) => { const s = opSummary(op, state.items); return <article key={op.id}><Tag color="red">{s.tag}</Tag><b>{s.detail}</b><small>{format(new Date(op.at), "HH:mm:ss")} · {op.client === state.clientId ? "本机" : "对端"}</small></article>; }) : <p>当前没有待同步操作。</p>}</div>
      <Button type="primary" disabled={!state.online || !state.queue.length} onClick={() => void dispatch(recoverQueue())}>主链路恢复后提交</Button>
      {!state.online && <small className="muted-note">当前处于断网应急模式，排片操作只在本地落地并入队。</small>}
    </Card>
    {merge && <Card title={merge.scope === "recovery" ? "上次恢复合并结果" : "上次在线同步结果"} className="merge-card">
      <div className="summary summary-compact"><span><b>{merge.submitted}</b> 本次提交</span><span><b>{merge.landed.length}</b> 成功落地</span><span><b>{merge.duplicateIds.length}</b> 重复去重</span><span className={merge.conflicts.length ? "danger-text" : ""}><b>{merge.conflicts.length}</b> 冲突拦截</span></div>
      <p>总时长 <b>{merge.durationBefore}</b> → <b>{merge.durationAfter}</b> 分钟{merge.durationChanged ? <Tag color="orange" className="epoch-tag">已变化，原硬时间风险失效并完成重算</Tag> : <Tag>未变化，沿用上轮风险结论</Tag>}</p>
      {merge.conflicts.length > 0 && <ul className="conflict-list">{merge.conflicts.map((c) => <li key={c.opId}><b>{c.detail}</b>：{c.reason}</li>)}</ul>}
      <small className="muted-note">{format(new Date(merge.at), "HH:mm:ss")} · 重复点击恢复不会重复插入，服务端幂等日志已登记全部提交过的操作。</small>
    </Card>}
  </div>;
}

function ChainPage({ mode }: { mode: "changes" | "history" }) {
  const state = useAppSelector((root) => root.rundown);
  if (mode === "changes") return <Card title="突发变更记录"><Timeline items={state.changes.map((item) => ({ children: <div><b>{item.headline}</b><p>{item.reason} · 插播 {item.duration} 分钟{item.client ? ` · ${item.client.includes("主编") ? "主编台" : "导播台"}` : ""}</p><small>{format(new Date(item.createdAt), "HH:mm:ss")}</small></div> }))} /></Card>;
  return <Card title="操作历史"><Timeline items={state.history.map((entry) => ({ color: entry.label.includes("恢复") ? "green" : "blue", children: <div><b>{entry.label}</b><p>{entry.detail}</p><small>{format(new Date(entry.time), "HH:mm:ss")}</small></div> }))} /></Card>;
}

function CollabPage() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.rundown);
  return <div className="chain-grid">
    <Card title="双终端协同与断网恢复">
      <p className="muted-note">直播开始后导播台与主编台同时编辑同一张串联单。断网期间的排片在各自终端本地落地并入应急队列，恢复后按字段“先改优先”合并；已播出状态永久锁定，任何后到修改都不能盖掉。</p>
      <div className="collab-actions">
        <Button onClick={() => dispatch(seedPeer())} disabled={!state.online}>模拟主编台断网期间已排片（对端加单 + 改时长）</Button>
        <Button danger={state.online} onClick={() => dispatch(setOnline(!state.online))}>{state.online ? "断开主链路（进入本地应急）" : "恢复主链路并合并"}</Button>
        <Button type="primary" disabled={!state.online || !state.queue.length} onClick={() => void dispatch(recoverQueue())}>立即提交应急队列（{state.queue.length}）</Button>
      </div>
      <ol className="rule-list">
        <li>字段级合并：同一字段先到的修改保留，后到修改被记录为冲突拦截；同一终端可继续修改自己持有的字段。</li>
        <li>已播出锁定：条目标记已播出后，取消、改时长等任何后到操作都不能覆盖该状态。</li>
        <li>合并后总时长一旦变化，原硬时间风险结论立即失效并按新排片重算（风险轮次 +1）。</li>
        <li>突发插播、取消、顺序调整全部结构化为应急操作，恢复时只提交尚未落地的操作。</li>
        <li>字幕 / 演播室越权修改在数据层直接拒绝并留痕；旧版数据自动升级，重复恢复幂等去重。</li>
      </ol>
    </Card>
    <Card title="权限矩阵与越权拒绝记录">
      <table className="perm-table">
        <thead><tr><th>岗位</th><th>新增/改条目/顺序</th><th>标记已播出</th><th>取消条目</th><th>突发插播</th></tr></thead>
        <tbody>
          <tr><td>导播</td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
          <tr><td>主编</td><td>✅</td><td>✅</td><td>❌</td><td>❌</td></tr>
          <tr><td>演播室</td><td>❌</td><td>✅</td><td>❌</td><td>❌</td></tr>
          <tr><td>字幕</td><td>❌</td><td>❌</td><td>❌</td><td>❌</td></tr>
        </tbody>
      </table>
      <div className="denial-list">{state.denials.length ? state.denials.map((d) => <article key={d.id}><Tag color="red">越权拒绝</Tag><b>{d.action}</b><small>{d.reason}</small><Button size="small" type="link" onClick={() => dispatch(acknowledgeDenial(d.id))}>清除</Button></article>) : <p className="muted-note">暂无越权尝试。把岗位切到“字幕”或“演播室”再操作串联单即可看到拒绝。</p>}</div>
    </Card>
  </div>;
}

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.rundown);
  const lastDenialId = useRef<string | null>(null);
  const lastMergeAt = useRef<string | null>(null);

  // 启动引导：服务端权威单 + 当前终端的岗位偏好与遗留应急队列
  useEffect(() => {
    const terminal = TERMINALS[0];
    const client = loadClient(terminal.id, { role: terminal.defaultRole, online: true });
    const server = loadServer();
    dispatch(bootstrap({
      clientId: terminal.id,
      role: client.prefs.role,
      online: client.prefs.online,
      items: client.prefs.online || !client.items.length ? server.items : client.items,
      changes: server.changes,
      queue: client.queue,
      migrated: server.migrated
    }));
  }, [dispatch]);

  // 各终端独立持久化（断网恢复后刷新页面，应急队列仍在且不会重复提交）
  useEffect(() => {
    if (!state.initialized) return;
    saveClient(state.clientId, { prefs: { role: state.role, online: state.online }, queue: state.queue, items: state.items });
  }, [state.initialized, state.clientId, state.role, state.online, state.queue, state.items]);

  // 在线且队列非空时防抖自动提交（覆盖“在线开关拨回恢复”与遗留队列）
  useEffect(() => {
    if (!state.initialized || !state.online || !state.queue.length) return;
    const timer = setTimeout(() => { void dispatch(recoverQueue({ quiet: true })); }, 800);
    return () => clearTimeout(timer);
  }, [state.initialized, state.online, state.queue, dispatch]);

  // 在线轮询对端终端的排片
  useEffect(() => {
    if (!state.initialized || !state.online) return;
    const timer = setInterval(() => { void dispatch(pullServer()); }, 10_000);
    return () => clearInterval(timer);
  }, [state.initialized, state.online, dispatch]);

  // 越权操作即时提示
  useEffect(() => {
    const newest = state.denials[0];
    if (newest && newest.id !== lastDenialId.current) {
      lastDenialId.current = newest.id;
      message.error({ content: `${newest.action}被拒绝：${newest.reason}`, duration: 4 });
    }
  }, [state.denials]);

  // 合并结果反馈
  useEffect(() => {
    if (state.lastMerge && state.lastMerge.at !== lastMergeAt.current) {
      lastMergeAt.current = state.lastMerge.at;
      const m = state.lastMerge;
      const text = m.scope === "recovery"
        ? `恢复合并：提交 ${m.submitted}，落地 ${m.landed.length}，去重 ${m.duplicateIds.length}，拦截 ${m.conflicts.length}${m.durationChanged ? "；时长已变，硬时间风险已重算" : ""}`
        : `已同步主编台排片${m.durationChanged ? "；时长已变，硬时间风险已重算" : ""}`;
      void message.info(text);
    }
  }, [state.lastMerge]);

  const switchTerminal = (clientId: string) => {
    const terminal = TERMINALS.find((t) => t.id === clientId)!;
    const client = loadClient(clientId, { role: terminal.defaultRole, online: true });
    const server = loadServer();
    dispatch(switchClient({
      clientId,
      role: client.prefs.role,
      online: client.prefs.online,
      items: client.prefs.online || !client.items.length ? server.items : client.items,
      changes: server.changes,
      queue: client.queue
    }));
  };

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span>LIVE</span><div><b>国际新闻直播</b><small>Control room</small></div></div><nav><NavLink to="/">串联单</NavLink><NavLink to="/collab">协同恢复</NavLink><NavLink to="/changes">突发变更</NavLink><NavLink to="/queue">应急队列 {state.queue.length ? <em>{state.queue.length}</em> : null}</NavLink><NavLink to="/history">操作历史</NavLink></nav></aside>
    <main><header className="topbar"><div><small>直播运行中 · 紧急操作均保留审计记录</small><h1>新闻直播编排台</h1></div><div className="top-actions"><label>终端 <Select value={state.clientId} onChange={switchTerminal} style={{ width: 168 }} options={TERMINALS.map((t) => ({ value: t.id, label: t.label }))} /></label><label>在线 <Switch checked={state.online} onChange={(value) => dispatch(setOnline(value))} /></label><label>岗位 <Select<Role> value={state.role} onChange={(value) => dispatch(setRole(value))} options={[{value:"导播"},{value:"主编"},{value:"字幕"},{value:"演播室"}]} /></label></div></header>
      {state.migrated && <Alert className="banner-alert" type="success" showIcon message="旧版串联单数据已自动升级，字段时间戳已补齐，历史排片继续参与协同合并。" />}
      <Routes><Route path="/" element={<RundownPage />} /><Route path="/collab" element={<CollabPage />} /><Route path="/changes" element={<ChainPage mode="changes" />} /><Route path="/queue" element={<QueuePage />} /><Route path="/history" element={<ChainPage mode="history" />} /></Routes></main>
  </div>;
}
