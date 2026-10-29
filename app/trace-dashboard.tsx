"use client";

import {
  Activity,
  BarChart3,
  Bot,
  Box,
  Braces,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Code2,
  Download,
  FileCode2,
  Filter,
  GitBranch,
  Globe2,
  Import,
  KeyRound,
  Layers3,
  ListTree,
  Menu,
  Network,
  OctagonX,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  TerminalSquare,
  Table2,
  UserRound,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_HERMES_TRACE_API || "http://127.0.0.1:4318";

type Evidence = "direct" | "reconciled" | "derived" | "unavailable";

interface PromptLayer {
  id: string;
  kind: string;
  title: string;
  source: string;
  hermesSessionId?: string;
  hermesTurnId?: string;
  hermesVersion?: string;
  provider?: string;
  profile?: string;
  captureMode?: string;
  captureCompleteness?: "full" | "standard" | "history" | "partial";
  costUsd?: number;
  evidence: Evidence;
  content: string;
  charCount?: number;
  hash?: string;
}

interface Trace {
  id: string;
  externalId?: string;
  source: string;
  title: string;
  status: string;
  cwd?: string;
  model?: string;
  userPrompt?: string;
  sessionPath?: string;
  promptLayers: PromptLayer[];
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  errorMessage?: string;
  eventCount: number;
  toolCallCount: number;
  errorCount: number;
}

interface TraceEvent {
  id: string;
  traceId: string;
  externalId: string;
  seq: number;
  timestamp: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  kind: string;
  category: string;
  title: string;
  actor: string;
  status: string;
  evidence: Evidence;
  parentId?: string;
  input?: unknown;
  output?: unknown;
  detail?: unknown;
  raw?: unknown;
}

interface HermesSession {
  id: string;
  title: string;
  preview: string;
  cwd?: string;
  model?: string;
  source?: string;
  profile?: string;
  timestamp: string;
  messageCount: number;
  toolCallCount: number;
  parentSessionId?: string;
  costUsd?: number;
}

interface HermesStatus {
  installed: boolean;
  version?: string;
  connected: boolean;
  gatewayUrl?: string;
  runtimeCheck?: { ok?: boolean; provider?: string; model?: string; error?: string };
  storage: { available: boolean; path: string; schemaVersion?: number };
  observer: { installed: boolean; enabled: boolean; tokenReady: boolean; sourcePath: string };
  captureChannels: { gateway: boolean; observer: boolean; sessionDb: boolean };
  lastError?: string;
}

interface Settings {
  hermes: HermesStatus;
  defaultCwd: string;
  databasePath: string;
  localOnly: boolean;
}

type ViewMode = "overview" | "timeline" | "graph" | "calls" | "prompt" | "raw";

const categoryMeta: Record<
  string,
  { label: string; color: string; icon: typeof Activity; lane: number }
> = {
  user: { label: "USER", color: "#28749a", icon: UserRound, lane: 0 },
  agent: { label: "AGENT", color: "#557d20", icon: Bot, lane: 1 },
  plan: { label: "PLAN", color: "#8f611c", icon: ListTree, lane: 1 },
  reasoning: { label: "REASON", color: "#6f55ac", icon: BrainCircuit, lane: 1 },
  llm: { label: "MODEL", color: "#356f8a", icon: BrainCircuit, lane: 1 },
  skill: { label: "SKILL", color: "#a45d1f", icon: Sparkles, lane: 2 },
  tool: { label: "TOOL", color: "#207b6d", icon: Wrench, lane: 3 },
  mcp: { label: "MCP", color: "#ae4669", icon: Network, lane: 3 },
  web: { label: "WEB", color: "#2f6fa9", icon: Globe2, lane: 3 },
  file: { label: "FILE", color: "#966414", icon: FileCode2, lane: 3 },
  artifact: { label: "ASSET", color: "#a148ab", icon: Box, lane: 3 },
  subagent: { label: "SUBAGENT", color: "#ad4d34", icon: GitBranch, lane: 4 },
  context: { label: "CONTEXT", color: "#58727d", icon: Layers3, lane: 2 },
  approval: { label: "APPROVAL", color: "#8a5631", icon: ShieldCheck, lane: 2 },
  interaction: { label: "INPUT", color: "#446f83", icon: CircleAlert, lane: 2 },
  error: { label: "ERROR", color: "#b14f49", icon: CircleAlert, lane: 2 },
  system: { label: "SYSTEM", color: "#58727d", icon: Activity, lane: 2 },
};

function metaFor(category: string) {
  return categoryMeta[category] || categoryMeta.system;
}

function statusLabel(status: string) {
  const map: Record<string, string> = {
    starting: "启动中",
    running: "运行中",
    inProgress: "运行中",
    completed: "已完成",
    failed: "失败",
    error: "错误",
    warning: "警告",
    interrupted: "已中断",
    declined: "已拒绝",
  };
  return map[status] || status;
}

function formatDuration(ms?: number | null) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatTime(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function relativeTime(value: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86_400)} 天前`;
}

function compactNumber(value: number) {
  return new Intl.NumberFormat("zh-CN", { notation: value > 9999 ? "compact" : "standard" }).format(
    value || 0,
  );
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败：${response.status}`);
  return body as T;
}

function StatusPill({ status }: { status: string }) {
  const active = ["starting", "running", "inProgress"].includes(status);
  return (
    <span className={`status-pill status-${status}`}>
      <span className={active ? "status-dot pulse" : "status-dot"} />
      {statusLabel(status)}
    </span>
  );
}

function EvidencePill({ evidence }: { evidence: Evidence }) {
  const labels = { direct: "直接证据", reconciled: "DB 补全", derived: "推断", unavailable: "不可观测" };
  return <span className={`evidence-pill evidence-${evidence}`}>{labels[evidence]}</span>;
}

function JsonBlock({ value, empty = "暂无数据" }: { value: unknown; empty?: string }) {
  if (value == null || (typeof value === "object" && Object.keys(value as object).length === 0)) {
    return <p className="muted-copy">{empty}</p>;
  }
  const content = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return <pre className="json-block">{content}</pre>;
}

const fieldLabels: Record<string, string> = {
  arguments: "调用参数",
  command: "命令",
  content: "内容",
  cwd: "工作目录",
  error: "错误",
  file: "文件",
  input: "输入",
  message: "消息",
  method: "方法",
  model: "模型",
  name: "名称",
  output: "输出",
  path: "路径",
  provider: "服务商",
  query: "查询",
  result: "结果",
  status: "状态",
  tool: "工具",
  url: "URL",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fieldLabel(key: string) {
  return fieldLabels[key] || key.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function scalarText(value: unknown) {
  if (value == null) return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return new Intl.NumberFormat("zh-CN").format(value);
  return String(value);
}

function StructuredData({ value, empty = "暂无数据", depth = 0 }: { value: unknown; empty?: string; depth?: number }) {
  if (value == null || (isRecord(value) && Object.keys(value).length === 0) || (Array.isArray(value) && value.length === 0)) {
    return <p className="muted-copy">{empty}</p>;
  }

  if (!isRecord(value) && !Array.isArray(value)) {
    return <div className="structured-text">{scalarText(value)}</div>;
  }

  if (Array.isArray(value)) {
    const objects = value.filter(isRecord);
    if (objects.length === value.length && objects.length > 0) {
      const columns = [...new Set(objects.flatMap((row) => Object.keys(row)))].slice(0, 6);
      return (
        <div className="data-table-wrap">
          <table className="data-table compact-table">
            <thead><tr>{columns.map((column) => <th key={column}>{fieldLabel(column)}</th>)}</tr></thead>
            <tbody>
              {objects.slice(0, 20).map((row, index) => (
                <tr key={index}>{columns.map((column) => <td key={column}>{isRecord(row[column]) || Array.isArray(row[column]) ? <span className="collection-value">{Array.isArray(row[column]) ? `${row[column].length} 项` : `${Object.keys(row[column] as object).length} 个字段`}</span> : scalarText(row[column])}</td>)}</tr>
              ))}
            </tbody>
          </table>
          {value.length > 20 && <p className="table-footnote">已展示前 20 项，共 {value.length} 项</p>}
        </div>
      );
    }
    return <div className="value-chip-list">{value.slice(0, 30).map((item, index) => <span key={index}>{scalarText(item)}</span>)}</div>;
  }

  return (
    <dl className="structured-fields">
      {Object.entries(value).map(([key, item]) => {
        const nested = isRecord(item) || Array.isArray(item);
        return (
          <div className={nested ? "structured-row nested" : "structured-row"} key={key}>
            <dt>{fieldLabel(key)}</dt>
            <dd>
              {nested ? (
                depth >= 2 ? <span className="collection-value">{Array.isArray(item) ? `${item.length} 项` : `${Object.keys(item).length} 个字段`}</span> :
                <details className="structured-details" open={depth === 0 && Object.keys(item as object).length <= 4}>
                  <summary>{Array.isArray(item) ? `${item.length} 项数据` : `${Object.keys(item as object).length} 个字段`}</summary>
                  <StructuredData value={item} depth={depth + 1} />
                </details>
              ) : <span>{scalarText(item)}</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function TraceListItem({ trace, active, onClick }: { trace: Trace; active: boolean; onClick: () => void }) {
  return (
    <button className={`trace-list-item ${active ? "active" : ""}`} onClick={onClick} type="button">
      <div className="trace-list-topline">
        <span className={`source-mark ${trace.captureMode === "history" ? "history" : "live"}`}>
          {trace.source.includes("history") ? <Import size={13} /> : <Zap size={13} />}
        </span>
        <span className="trace-list-title">{trace.title}</span>
        <ChevronRight className="trace-chevron" size={15} />
      </div>
      <div className="trace-list-meta">
        <span>{relativeTime(trace.startedAt)}</span>
        <span>·</span>
        <span>{trace.eventCount} events</span>
        <span className={`mini-state state-${trace.status}`}>{statusLabel(trace.status)}</span>
      </div>
    </button>
  );
}

function EmptyState({
  hermes,
  onRun,
  onImport,
}: {
  hermes?: HermesStatus;
  onRun: () => void;
  onImport: () => void;
}) {
  return (
    <section className="empty-state">
      <div className="empty-orbit" aria-hidden="true">
        <span className="orbit-node node-user"><UserRound size={19} /></span>
        <span className="orbit-line line-one" />
        <span className="orbit-node node-agent"><BrainCircuit size={20} /></span>
        <span className="orbit-line line-two" />
        <span className="orbit-node node-tool"><TerminalSquare size={20} /></span>
      </div>
      <p className="eyebrow">HERMES EXECUTION OBSERVABILITY</p>
      <h1>看清 Hermes，<br />从请求到结果。</h1>
      <p className="empty-description">
        记录 Prompt 组装、模型请求、工具、Skill、MCP、子 Agent 与人工审批。数据只保存在本机。
      </p>
      <div className="empty-actions">
        <button className="primary-button" onClick={onRun} type="button">
          <Play size={16} fill="currentColor" /> 启动首条 Trace
        </button>
        <button className="secondary-button" onClick={onImport} type="button">
          <Import size={16} /> 导入 Hermes Session
        </button>
      </div>
      <div className="empty-features">
        <span><ShieldCheck size={15} /> 本地存储</span>
        <span><Activity size={15} /> 实时事件</span>
        <span><KeyRound size={15} /> 默认脱敏</span>
      </div>
      <div className="runtime-channels" aria-label="Hermes 捕获通道状态">
        <div className={hermes?.captureChannels.gateway ? "ready" : ""}>
          <Zap size={15} /><span><strong>Gateway</strong><small>{hermes?.connected ? "已连接" : hermes?.installed ? "按需启动" : "未安装"}</small></span>
        </div>
        <div className={hermes?.captureChannels.observer ? "ready" : ""}>
          <Activity size={15} /><span><strong>Observer</strong><small>{hermes?.observer.enabled ? "深度事件已启用" : "可选增强未启用"}</small></span>
        </div>
        <div className={hermes?.captureChannels.sessionDb ? "ready" : ""}>
          <Layers3 size={15} /><span><strong>SessionDB</strong><small>{hermes?.storage.available ? `Schema ${hermes.storage.schemaVersion || "ready"}` : "不可用"}</small></span>
        </div>
      </div>
      <section className="home-guide" aria-labelledby="home-guide-title">
        <div className="home-guide-heading">
          <div>
            <p className="eyebrow">QUICK START</p>
            <h2 id="home-guide-title">三步开始观察一条 Hermes 请求</h2>
          </div>
          <p>从一次用户输入出发，把 Agent 如何思考、调用和收尾，整理成可以回看的证据链。</p>
        </div>
        <div className="home-guide-steps">
          <article className="home-guide-step">
            <span className="guide-step-number">01</span>
            <div>
              <h3>启动本地工作台</h3>
              <p>在项目目录执行 <code>npm run dev</code>，Trace Studio 会启动本地界面和采集 API。</p>
            </div>
          </article>
          <article className="home-guide-step">
            <span className="guide-step-number">02</span>
            <div>
              <h3>发起或导入请求</h3>
              <p>点击“新 Trace”发送一次请求，或从 Hermes SessionDB 只读导入已有会话。</p>
            </div>
          </article>
          <article className="home-guide-step">
            <span className="guide-step-number">03</span>
            <div>
              <h3>沿证据链复盘</h3>
              <p>选择事件查看输入、输出、耗时和原始字段，并按需导出整条 Trace。</p>
            </div>
          </article>
        </div>
        <div className="home-capability-heading">
          <p className="eyebrow">WHAT YOU CAN SEE</p>
          <h2>一页看懂 Hermes 的工作流</h2>
        </div>
        <div className="home-capabilities">
          <article className="home-capability-card">
            <span className="capability-icon"><ListTree size={17} /></span>
            <div><h3>时间线与流程图</h3><p>按先后顺序或节点关系查看 Agent、模型、工具、MCP 和子 Agent 的调用链。</p></div>
          </article>
          <article className="home-capability-card">
            <span className="capability-icon"><Layers3 size={17} /></span>
            <div><h3>Prompt 分层</h3><p>展示用户请求、系统指令、项目规则和运行时上下文等可确认的提示词来源。</p></div>
          </article>
          <article className="home-capability-card">
            <span className="capability-icon"><Wrench size={17} /></span>
            <div><h3>工具、Skill 与 MCP</h3><p>识别工具类别、参数、结果、耗时和状态，区分普通工具、Skill、MCP 与 Web 调用。</p></div>
          </article>
          <article className="home-capability-card">
            <span className="capability-icon"><Activity size={17} /></span>
            <div><h3>实时与深度观测</h3><p>Gateway 提供实时流程，Observer 插件补充 LLM、API、审批和 Subagent 生命周期事件。</p></div>
          </article>
          <article className="home-capability-card">
            <span className="capability-icon"><Import size={17} /></span>
            <div><h3>历史 Session 导入</h3><p>从 Hermes 的 state.db 恢复过去的用户轮次，不改写原数据库，并明确标注历史证据。</p></div>
          </article>
          <article className="home-capability-card">
            <span className="capability-icon"><Braces size={17} /></span>
            <div><h3>Raw 与证据标记</h3><p>查看脱敏后的原始事件 JSON，区分直接证据、数据库补全、推断和不可观测内容。</p></div>
          </article>
        </div>
        <div className="home-guide-note"><ShieldCheck size={15} /><span>默认只在本机保存数据；未公开的隐藏思维链不会被猜测或伪造。</span></div>
      </section>
    </section>
  );
}

const callCategories = new Set(["llm", "tool", "mcp", "web", "file", "artifact", "skill", "subagent"]);

function TraceOverview({
  trace,
  events,
  onSelect,
}: {
  trace: Trace;
  events: TraceEvent[];
  onSelect: (event: TraceEvent) => void;
}) {
  const categoryStats = useMemo(() => {
    const stats = new Map<string, { count: number; duration: number }>();
    events.forEach((event) => {
      const current = stats.get(event.category) || { count: 0, duration: 0 };
      current.count += 1;
      current.duration += event.durationMs || 0;
      stats.set(event.category, current);
    });
    return [...stats.entries()]
      .map(([category, stat]) => ({ category, ...stat }))
      .sort((left, right) => right.count - left.count);
  }, [events]);
  const durationLeaders = useMemo(
    () => [...events].filter((event) => (event.durationMs || 0) > 0).sort((left, right) => (right.durationMs || 0) - (left.durationMs || 0)).slice(0, 6),
    [events],
  );
  const callEvents = events.filter((event) => callCategories.has(event.category));
  const completed = events.filter((event) => event.status === "completed").length;
  const direct = events.filter((event) => event.evidence === "direct").length;
  const errorEvents = events.filter((event) => ["error", "failed", "declined"].includes(event.status)).length;
  const maxCategoryCount = Math.max(1, ...categoryStats.map((item) => item.count));
  const maxDuration = Math.max(1, ...durationLeaders.map((event) => event.durationMs || 0));
  const flowEvents = events.length <= 14
    ? events
    : Array.from({ length: 14 }, (_, index) => events[Math.round(index * (events.length - 1) / 13)]);
  const donutParts = categoryStats.map((item, index) => {
    const previousCount = categoryStats.slice(0, index).reduce((sum, current) => sum + current.count, 0);
    const start = events.length ? (previousCount / events.length) * 100 : 0;
    const end = events.length ? ((previousCount + item.count) / events.length) * 100 : 0;
    return `${metaFor(item.category).color} ${start}% ${end}%`;
  });

  return (
    <div className="overview-view">
      <section className="overview-summary" aria-label="Trace 执行摘要">
        <article><span className="summary-icon"><Activity size={17} /></span><div><small>执行完成度</small><strong>{events.length ? Math.round((completed / events.length) * 100) : 0}%</strong><em>{completed} / {events.length} 事件完成</em></div></article>
        <article><span className="summary-icon"><Wrench size={17} /></span><div><small>调用规模</small><strong>{callEvents.length}</strong><em>工具、Skill 与外部调用</em></div></article>
        <article><span className="summary-icon"><ShieldCheck size={17} /></span><div><small>直接证据</small><strong>{events.length ? Math.round((direct / events.length) * 100) : 0}%</strong><em>{direct} 条来自运行时</em></div></article>
        <article className={errorEvents ? "summary-alert" : ""}><span className="summary-icon"><CircleAlert size={17} /></span><div><small>异常事件</small><strong>{errorEvents}</strong><em>{errorEvents ? "需要查看错误节点" : "未发现失败节点"}</em></div></article>
      </section>

      <section className="analysis-panel flow-overview-panel">
        <div className="panel-heading"><div><p className="eyebrow">EXECUTION FLOW</p><h2>主流程摘要</h2></div><span>{events.length} 个事件 · {formatDuration(trace.durationMs)}</span></div>
        {flowEvents.length ? (
          <div className="flow-strip">
            {flowEvents.map((event, index) => {
              const meta = metaFor(event.category);
              const Icon = meta.icon;
              return (
                <button className="flow-step" key={event.id} onClick={() => onSelect(event)} type="button">
                  <span className="flow-step-node" style={{ borderColor: meta.color, color: meta.color }}><Icon size={15} /></span>
                  <span className="flow-step-copy"><small>{meta.label}</small><strong>{event.title}</strong><em>{formatDuration(event.durationMs)}</em></span>
                  {index < flowEvents.length - 1 && <ChevronRight className="flow-step-arrow" size={15} />}
                </button>
              );
            })}
          </div>
        ) : <div className="view-empty"><Activity size={24} /><p>还没有可展示的流程事件。</p></div>}
        {events.length > flowEvents.length && <p className="panel-note">主流程已均匀抽取 {flowEvents.length} 个关键节点，完整顺序可在“时间线”查看。</p>}
      </section>

      <div className="analysis-grid">
        <section className="analysis-panel category-panel">
          <div className="panel-heading"><div><p className="eyebrow">EVENT MIX</p><h2>事件类型分布</h2></div><span>共 {events.length} 条</span></div>
          <div className="distribution-layout">
            <div className="distribution-donut" style={{ background: donutParts.length ? `conic-gradient(${donutParts.join(", ")})` : "var(--line)" }}><span><strong>{categoryStats.length}</strong><small>类事件</small></span></div>
            <div className="bar-list">
              {categoryStats.map((item) => {
                const meta = metaFor(item.category);
                return <div className="bar-row" key={item.category}><span className="bar-label"><i style={{ background: meta.color }} />{meta.label}</span><span className="bar-track"><i style={{ background: meta.color, width: `${(item.count / maxCategoryCount) * 100}%` }} /></span><strong>{item.count}</strong></div>;
              })}
            </div>
          </div>
        </section>

        <section className="analysis-panel duration-panel">
          <div className="panel-heading"><div><p className="eyebrow">DURATION</p><h2>耗时最长的环节</h2></div><span>Top {durationLeaders.length}</span></div>
          <div className="duration-bars">
            {durationLeaders.map((event) => {
              const meta = metaFor(event.category);
              return <button key={event.id} onClick={() => onSelect(event)} type="button"><span><i style={{ color: meta.color }}>{meta.label}</i><strong>{event.title}</strong></span><span className="duration-track"><i style={{ background: meta.color, width: `${((event.durationMs || 0) / maxDuration) * 100}%` }} /></span><em>{formatDuration(event.durationMs)}</em></button>;
            })}
            {!durationLeaders.length && <p className="muted-copy">当前事件没有可用的耗时数据。</p>}
          </div>
        </section>
      </div>
    </div>
  );
}

function CallsView({ events, onSelect }: { events: TraceEvent[]; onSelect: (event: TraceEvent) => void }) {
  const calls = events.filter((event) => callCategories.has(event.category));
  const external = calls.filter((event) => ["llm", "mcp", "web", "subagent"].includes(event.category));
  const failed = calls.filter((event) => ["error", "failed", "declined"].includes(event.status));
  const totalDuration = calls.reduce((sum, event) => sum + (event.durationMs || 0), 0);
  const callStats = [...new Set(calls.map((event) => event.category))].map((category) => ({
    category,
    count: calls.filter((event) => event.category === category).length,
  }));

  return (
    <div className="calls-view">
      <section className="calls-hero">
        <div><p className="eyebrow">TOOLS &amp; EXTERNAL CALLS</p><h2>工具与外部调用</h2><p>将模型 API、Skill、本地工具、文件、MCP、Web 和子 Agent 从主时间线中单独拆出，便于检查依赖、耗时和失败点。</p></div>
        <div className="calls-kpis"><span><small>全部调用</small><strong>{calls.length}</strong></span><span><small>外部通道</small><strong>{external.length}</strong></span><span className={failed.length ? "danger" : ""}><small>失败</small><strong>{failed.length}</strong></span><span><small>累计耗时</small><strong>{formatDuration(totalDuration)}</strong></span></div>
      </section>

      <section className="call-channel-strip" aria-label="调用通道分布">
        {callStats.map((item) => {
          const meta = metaFor(item.category);
          const Icon = meta.icon;
          return <article key={item.category}><span style={{ color: meta.color }}><Icon size={17} /></span><div><small>{meta.label}</small><strong>{item.count}</strong></div></article>;
        })}
        {!callStats.length && <p className="muted-copy">这条 Trace 还没有工具或外部调用。</p>}
      </section>

      {calls.length > 0 && (
        <section className="analysis-panel calls-table-panel">
          <div className="panel-heading"><div><p className="eyebrow">CALL LOG</p><h2>调用明细</h2></div><span>点击行查看结构化输入与输出</span></div>
          <div className="data-table-wrap">
            <table className="data-table calls-table">
              <thead><tr><th>#</th><th>通道</th><th>调用名称</th><th>Actor</th><th>状态</th><th>耗时</th><th>证据</th><th>时间</th></tr></thead>
              <tbody>{calls.map((event) => {
                const meta = metaFor(event.category);
                const Icon = meta.icon;
                return <tr key={event.id} onClick={() => onSelect(event)} tabIndex={0} onKeyDown={(keyEvent) => { if (keyEvent.key === "Enter" || keyEvent.key === " ") onSelect(event); }}><td>{String(event.seq).padStart(2, "0")}</td><td><span className="table-channel" style={{ color: meta.color }}><Icon size={14} />{meta.label}</span></td><td><strong>{event.title}</strong><small>{event.kind}</small></td><td>{event.actor}</td><td><span className={`event-state event-state-${event.status}`}>{statusLabel(event.status)}</span></td><td>{formatDuration(event.durationMs)}</td><td><EvidencePill evidence={event.evidence} /></td><td>{formatTime(event.timestamp)}</td></tr>;
              })}</tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function Timeline({
  events,
  selectedId,
  onSelect,
  category,
}: {
  events: TraceEvent[];
  selectedId?: string;
  onSelect: (event: TraceEvent) => void;
  category: string;
}) {
  const visible = category === "all" ? events : events.filter((event) => event.category === category);
  if (!visible.length) {
    return <div className="view-empty"><Filter size={24} /><p>当前筛选条件下没有事件。</p></div>;
  }
  return (
    <div className="timeline">
      {visible.map((event, index) => {
        const meta = metaFor(event.category);
        const Icon = meta.icon;
        return (
          <button
            className={`timeline-event ${selectedId === event.id ? "selected" : ""}`}
            key={event.id}
            onClick={() => onSelect(event)}
            type="button"
          >
            <div className="timeline-rail" aria-hidden="true">
              <span className="timeline-index">{String(event.seq).padStart(2, "0")}</span>
              <span className="timeline-node" style={{ borderColor: meta.color, color: meta.color }}>
                <Icon size={16} />
              </span>
              {index < visible.length - 1 && <span className="timeline-line" />}
            </div>
            <div className="event-card">
              <div className="event-card-head">
                <span className="category-label" style={{ color: meta.color }}>{meta.label}</span>
                <span className="event-title">{event.title}</span>
                <span className={`event-state event-state-${event.status}`}>{statusLabel(event.status)}</span>
              </div>
              <div className="event-card-meta">
                <span>{formatTime(event.timestamp)}</span>
                {event.durationMs != null && <><span>·</span><span>{formatDuration(event.durationMs)}</span></>}
                <span>·</span>
                <EvidencePill evidence={event.evidence} />
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function TraceGraph({ events, onSelect }: { events: TraceEvent[]; onSelect: (event: TraceEvent) => void }) {
  const nodes = useMemo<Node[]>(
    () =>
      events.map((event, index) => {
        const meta = metaFor(event.category);
        const Icon = meta.icon;
        return {
          id: event.id,
          position: { x: meta.lane * 250, y: index * 112 },
          data: {
            label: (
              <div className="flow-node-label">
                <span className="flow-node-icon" style={{ color: meta.color }}><Icon size={15} /></span>
                <span>
                  <small style={{ color: meta.color }}>{meta.label}</small>
                  <strong>{event.title}</strong>
                </span>
              </div>
            ),
          },
          style: {
            width: 220,
            minHeight: 68,
            color: "#18343d",
            background: "#f0faf9",
            border: `1px solid ${meta.color}55`,
            borderRadius: 12,
            boxShadow: "0 8px 20px rgba(45,117,126,.08)",
            textAlign: "left" as const,
          },
        };
      }),
    [events],
  );
  const edges = useMemo<Edge[]>(() => {
    const output: Edge[] = [];
    events.forEach((event, index) => {
      if (index > 0) {
        output.push({
          id: `sequence-${events[index - 1].id}-${event.id}`,
          source: events[index - 1].id,
          target: event.id,
          animated: ["running", "starting"].includes(event.status),
          markerEnd: { type: MarkerType.ArrowClosed, color: "#596475" },
          style: { stroke: "#596475", strokeWidth: 1.5 },
        });
      }
      if (event.parentId && events.some((candidate) => candidate.id === event.parentId)) {
        output.push({
          id: `parent-${event.parentId}-${event.id}`,
          source: event.parentId,
          target: event.id,
          style: { stroke: "#a45d1f", strokeDasharray: "5 5" },
        });
      }
    });
    return output;
  }, [events]);

  return (
    <div className="graph-canvas">
      <div className="lane-labels">
        {["USER", "AGENT", "CONTEXT", "TOOLS", "SUBAGENT"].map((label) => <span key={label}>{label}</span>)}
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.15}
        maxZoom={1.6}
        onNodeClick={(_, node) => {
          const event = events.find((candidate) => candidate.id === node.id);
          if (event) onSelect(event);
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#b5d5da" gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function PromptView({ layers }: { layers: PromptLayer[] }) {
  const [expanded, setExpanded] = useState<string | null>(layers[0]?.id || null);
  if (!layers.length) {
    return <div className="view-empty"><Layers3 size={25} /><p>该 Trace 没有可读取的提示词快照。</p></div>;
  }
  return (
    <div className="prompt-layers">
      <div className="prompt-notice">
        <ShieldCheck size={17} />
        <p>这里展示运行时可确认的提示词分层。供应商未公开的内部指令与原始隐式思维链不会被虚构。</p>
      </div>
      {layers.map((layer, index) => {
        const open = expanded === layer.id;
        return (
          <section className={`prompt-layer ${open ? "open" : ""}`} key={layer.id}>
            <button onClick={() => setExpanded(open ? null : layer.id)} type="button">
              <span className="layer-number">{String(index + 1).padStart(2, "0")}</span>
              <span className="layer-main">
                <strong>{layer.title}</strong>
                <small>{layer.source}</small>
              </span>
              <span className="layer-count">{compactNumber(layer.charCount || layer.content?.length || 0)} chars</span>
              <EvidencePill evidence={layer.evidence || "direct"} />
              {open ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
            </button>
            {open && (
              <div className="prompt-layer-content">
                <pre>{layer.content}</pre>
                {layer.hash && <span className="hash-line">SHA-256 · {layer.hash}</span>}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function RawView({ events, loading }: { events: unknown[]; loading: boolean }) {
  if (loading) return <div className="view-empty"><RefreshCw className="spin" size={24} /><p>正在读取脱敏后的原始事件…</p></div>;
  return (
    <div className="raw-view">
      <div className="raw-toolbar"><Braces size={16} /><span>{events.length} 条原始事件 · 默认脱敏</span></div>
      <JsonBlock value={events} />
    </div>
  );
}

function Inspector({ event, onClose }: { event?: TraceEvent; onClose: () => void }) {
  if (!event) {
    return (
      <aside className="inspector inspector-empty">
        <div className="inspector-empty-icon"><Search size={23} /></div>
        <h3>事件检查器</h3>
        <p>选择总览、时间线、流程图或调用表中的节点，查看结构化输入、输出与证据。</p>
      </aside>
    );
  }
  const meta = metaFor(event.category);
  const Icon = meta.icon;
  return (
    <aside className="inspector inspector-active">
      <div className="inspector-head">
        <div className="inspector-kicker" style={{ color: meta.color }}><Icon size={15} /> {meta.label}</div>
        <button className="icon-button inspector-close" onClick={onClose} type="button" aria-label="关闭检查器"><X size={17} /></button>
      </div>
      <h2>{event.title}</h2>
      <div className="inspector-pills"><StatusPill status={event.status} /><EvidencePill evidence={event.evidence} /></div>
      <dl className="property-grid">
        <div><dt>序号</dt><dd>#{event.seq}</dd></div>
        <div><dt>耗时</dt><dd>{formatDuration(event.durationMs)}</dd></div>
        <div><dt>事件类型</dt><dd>{event.kind}</dd></div>
        <div><dt>Actor</dt><dd>{event.actor}</dd></div>
        <div className="wide"><dt>时间</dt><dd>{formatTime(event.timestamp)}</dd></div>
      </dl>
      <section className="inspector-section"><h3>输入</h3><StructuredData value={event.input} /></section>
      <section className="inspector-section"><h3>输出</h3><StructuredData value={event.output} /></section>
      {event.detail != null && <section className="inspector-section"><h3>上下文</h3><StructuredData value={event.detail} /></section>}
      <details className="raw-details">
        <summary>开发者原始 JSON <ChevronDown size={14} /></summary>
        <JsonBlock value={event.raw} />
      </details>
    </aside>
  );
}

function RunModal({
  settings,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  settings?: Settings;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onSubmit: (value: { prompt: string; cwd: string; model: string; provider: string; profile: string; reasoningEffort: string; fast: boolean }) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState(settings?.defaultCwd || "");
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [profile, setProfile] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("medium");
  const [fast, setFast] = useState(false);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal-card run-modal" role="dialog" aria-modal="true" aria-labelledby="run-title">
        <div className="modal-head">
          <div><p className="eyebrow">NEW HERMES TRACE</p><h2 id="run-title">向 Hermes 发送一次请求</h2></div>
          <button className="icon-button" onClick={onClose} type="button" aria-label="关闭"><X size={18} /></button>
        </div>
        <label className="field-label">用户请求</label>
        <textarea autoFocus className="prompt-input" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：分析当前项目的登录调用链，只读取文件，不做修改。" rows={7} />
        <div className="form-row">
          <label><span className="field-label">工作目录</span><input value={cwd} onChange={(event) => setCwd(event.target.value)} /></label>
          <label><span className="field-label">模型（可选）</span><input value={model} onChange={(event) => setModel(event.target.value)} placeholder="使用 Hermes Profile 默认模型" /></label>
        </div>
        <div className="form-row">
          <label><span className="field-label">Provider（可选）</span><input value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="由 Hermes 自动解析" /></label>
          <label><span className="field-label">Profile（可选）</span><input value={profile} onChange={(event) => setProfile(event.target.value)} placeholder="当前 Hermes Profile" /></label>
        </div>
        <div className="access-choice">
          <span className="field-label">Reasoning effort</span>
          <div className="segmented large">
            {["none", "low", "medium", "high"].map((effort) => <button className={reasoningEffort === effort ? "active" : ""} key={effort} onClick={() => setReasoningEffort(effort)} type="button"><BrainCircuit size={15} /><span><strong>{effort}</strong><small>{effort === "medium" ? "Hermes 常用值" : "按任务选择"}</small></span></button>)}
          </div>
          <label className="fast-choice"><input checked={fast} onChange={(event) => setFast(event.target.checked)} type="checkbox" /><span>优先服务层（Fast）</span></label>
        </div>
        <div className="modal-foot">
          <span className="local-note"><ShieldCheck size={14} /> 保留 Hermes 的审批、Clarify 与 Secret 流程</span>
          <button className="primary-button" disabled={busy || !prompt.trim() || !cwd.trim()} onClick={() => onSubmit({ prompt, cwd, model, provider, profile, reasoningEffort, fast })} type="button">
            {busy ? <RefreshCw className="spin" size={16} /> : <Play size={16} fill="currentColor" />} {busy ? "正在启动…" : "启动 Trace"}
          </button>
        </div>
        {error && <p className="form-error"><CircleAlert size={15} /> {error}</p>}
      </div>
    </div>
  );
}

function ImportModal({
  sessions,
  busy,
  error,
  onClose,
  onRefresh,
  onImport,
}: {
  sessions: HermesSession[];
  busy: boolean;
  error?: string;
  onClose: () => void;
  onRefresh: () => void;
  onImport: (session: HermesSession) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = sessions.filter((session) => `${session.title} ${session.cwd || ""}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal-card import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <div className="modal-head">
          <div><p className="eyebrow">HERMES SESSIONDB</p><h2 id="import-title">导入 Hermes Session</h2></div>
          <button className="icon-button" onClick={onClose} type="button" aria-label="关闭"><X size={18} /></button>
        </div>
        <div className="session-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索请求或工作目录" /><button className="icon-button" onClick={onRefresh} type="button" aria-label="刷新"><RefreshCw size={15} /></button></div>
        <div className="session-list">
          {filtered.map((session) => (
            <button className="session-item" disabled={busy} key={session.id} onClick={() => onImport(session)} type="button">
              <span className="session-icon"><Code2 size={18} /></span>
              <span className="session-copy"><strong>{session.title}</strong><small>{session.cwd || "未绑定工作目录"}</small><em>{formatTime(session.timestamp)} · {session.model || "Hermes"} · {session.messageCount} messages</em></span>
              <Import size={17} />
            </button>
          ))}
          {!filtered.length && <div className="session-empty">没有找到可导入的 Hermes Session。</div>}
        </div>
        {error && <p className="form-error"><CircleAlert size={15} /> {error}</p>}
        <p className="import-footnote">一个 Session 中的多次用户请求会拆分为多条 Trace。state.db 始终以只读方式访问。</p>
      </div>
    </div>
  );
}

export function TraceDashboard() {
  const [traces, setTraces] = useState<Trace[]>([]);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<TraceEvent>();
  const [settings, setSettings] = useState<Settings>();
  const [sessions, setSessions] = useState<HermesSession[]>([]);
  const [rawEvents, setRawEvents] = useState<unknown[]>([]);
  const [rawLoading, setRawLoading] = useState(false);
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [modal, setModal] = useState<"run" | "import" | null>(null);
  const [view, setView] = useState<ViewMode>("overview");
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [traceHeaderCollapsed, setTraceHeaderCollapsed] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadTraces = useCallback(async (preferredId?: string) => {
    const result = await api<{ traces: Trace[] }>("/api/traces");
    setTraces(result.traces);
    const id = preferredId || trace?.id || result.traces[0]?.id;
    if (id) {
      const selected = result.traces.find((candidate) => candidate.id === id) || result.traces[0];
      setTrace(selected);
    } else {
      setTrace(null);
    }
    return result.traces;
  }, [trace?.id]);

  const loadTrace = useCallback(async (traceId: string) => {
    const result = await api<{ trace: Trace; events: TraceEvent[] }>(`/api/traces/${encodeURIComponent(traceId)}`);
    setTrace(result.trace);
    setEvents(result.events);
    setSelectedEvent((current) => result.events.find((event) => event.id === current?.id));
    return result;
  }, []);

  const loadSessions = useCallback(async () => {
    const result = await api<{ sessions: HermesSession[] }>("/api/hermes/sessions");
    setSessions(result.sessions);
  }, []);

  const connectHermes = useCallback(async () => {
    const result = await api<{ hermes: HermesStatus }>("/api/hermes/connect", { method: "POST", body: "{}" });
    setSettings((current) => current ? { ...current, hermes: result.hermes } : current);
    return result.hermes;
  }, []);

  useEffect(() => {
    void Promise.all([api<Settings>("/api/settings"), api<{ traces: Trace[] }>("/api/traces")])
      .then(([settingsResult, traceResult]) => {
        setSettings(settingsResult);
        setTraces(traceResult.traces);
        setTrace(traceResult.traces[0] || null);
        if (traceResult.traces[0]) void loadTrace(traceResult.traces[0].id);
        setBackendOnline(true);
      })
      .catch((caught) => {
        setBackendOnline(false);
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => setLoading(false));
  }, [loadTrace]);

  useEffect(() => {
    const source = new EventSource(`${API_BASE}/api/stream?traceId=*`);
    source.addEventListener("ready", () => setBackendOnline(true));
    source.addEventListener("trace", (message) => {
      const payload = JSON.parse((message as MessageEvent).data || "{}");
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        void loadTraces(trace?.id).then(() => {
          if (payload.traceId === trace?.id) void loadTrace(payload.traceId);
        });
      }, 120);
    });
    source.onerror = () => setBackendOnline(false);
    return () => {
      source.close();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [loadTrace, loadTraces, trace?.id]);

  async function selectView(nextView: ViewMode) {
    setView(nextView);
    if (nextView !== "raw" || !trace?.id) return;
    setRawLoading(true);
    try {
      const result = await api<{ rawEvents: unknown[] }>(`/api/traces/${encodeURIComponent(trace.id)}/raw`);
      setRawEvents(result.rawEvents);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRawLoading(false);
    }
  }

  async function startRun(value: { prompt: string; cwd: string; model: string; provider: string; profile: string; reasoningEffort: string; fast: boolean }) {
    setBusy(true);
    setError(undefined);
    try {
      if (!settings?.hermes.connected) await connectHermes();
      const result = await api<{ trace: Trace }>("/api/hermes/turns", { method: "POST", body: JSON.stringify(value) });
      setModal(null);
      setTrace(result.trace);
      setView("overview");
      await loadTraces(result.trace.id);
      await loadTrace(result.trace.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function importSession(session: HermesSession) {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api<{ traceIds: string[] }>("/api/hermes/imports", { method: "POST", body: JSON.stringify({ sessionId: session.id, profile: session.profile }) });
      setModal(null);
      setView("overview");
      await loadTraces(result.traceIds.at(-1));
      if (result.traceIds.at(-1)) await loadTrace(result.traceIds.at(-1)!);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function stopRun() {
    if (!trace) return;
    try {
      await api(`/api/hermes/turns/${encodeURIComponent(trace.id)}/actions`, { method: "POST", body: JSON.stringify({ type: "interrupt" }) });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  const filteredTraces = traces.filter((item) => `${item.title} ${item.cwd || ""}`.toLowerCase().includes(query.toLowerCase()));
  const categories = useMemo(() => [...new Set(events.map((event) => event.category))], [events]);
  const isRunning = trace && ["starting", "running", "inProgress"].includes(trace.status);

  return (
    <main className="app-shell">
      <button
        className={`sidebar-reveal ${sidebarCollapsed ? "visible" : ""} ${!sidebarOpen ? "mobile-visible" : ""}`}
        onClick={() => { setSidebarCollapsed(false); setSidebarOpen(true); }}
        type="button"
        aria-label="展开侧边栏"
      ><Menu size={18} /><span>打开导航</span></button>

      <div className={`workspace ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${selectedEvent ? "has-inspector" : ""}`}>
        <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
          <div className="sidebar-brand-row">
            <div className="brand"><span className="brand-mark"><Activity size={18} /></span><span><strong>Hermes Trace</strong><small>STUDIO</small></span></div>
            <button className="icon-button sidebar-collapse-button" onClick={() => { setSidebarCollapsed(true); setSidebarOpen(false); }} type="button" aria-label="收起侧边栏"><ChevronRight size={17} /></button>
          </div>

          <section className="sidebar-runtime-card" aria-label="Hermes 运行时与当前项目">
            <div className="sidebar-runtime-head"><span><BrainCircuit size={14} /> Hermes Runtime</span><span className={`connection ${backendOnline && settings?.hermes.connected ? "online" : "offline"}`}><span />{!backendOnline ? "API OFFLINE" : settings?.hermes.connected ? `HERMES ${settings.hermes.version || "READY"}` : settings?.hermes.installed ? "HERMES IDLE" : "HERMES MISSING"}</span></div>
            <div className="sidebar-current-project"><small>CURRENT PROJECT</small><strong>{trace?.title || "等待首条 Trace"}</strong><span><Code2 size={13} /> {trace?.cwd || settings?.defaultCwd || "未绑定工作目录"}</span></div>
            <div className="sidebar-primary-actions">
              <button className="secondary-button compact" onClick={() => { setError(undefined); void loadSessions().then(() => setModal("import")); }} type="button"><Import size={15} /> 导入</button>
              <button className="primary-button compact" onClick={() => { setError(undefined); setModal("run"); }} type="button"><Plus size={16} /> 新 Trace</button>
              {trace && <a className="icon-button sidebar-export" href={`${API_BASE}/api/traces/${encodeURIComponent(trace.id)}/export`} download aria-label="导出 Trace"><Download size={17} /></a>}
            </div>
          </section>

          <div className="sidebar-head"><span>TRACE HISTORY</span><button className="icon-button" onClick={() => void loadTraces()} type="button" aria-label="刷新"><RefreshCw size={14} /></button></div>
          <div className="sidebar-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Trace" /></div>
          <div className="trace-list">
            {filteredTraces.map((item) => <TraceListItem active={trace?.id === item.id} key={item.id} trace={item} onClick={() => { setTrace(item); setView("overview"); setRawEvents([]); setSidebarOpen(false); setSelectedEvent(undefined); void loadTrace(item.id); }} />)}
            {!filteredTraces.length && <p className="trace-list-empty">还没有 Trace 记录</p>}
          </div>
          <div className="sidebar-foot"><ShieldCheck size={14} /><span>LOCAL ONLY<br /><small>{settings?.databasePath?.split("/").at(-1) || "traces.db"}</small></span></div>
        </aside>

        <section className="content-area">
          {!backendOnline && !loading && (
            <div className="offline-banner"><CircleAlert size={16} /><span>本地 Trace API 未连接。请使用项目的开发启动方式运行前端与采集服务。</span></div>
          )}
          {backendOnline && settings && !settings.hermes.installed && (
            <div className="offline-banner"><CircleAlert size={16} /><span>没有检测到 Hermes CLI。安装 Hermes 后才能启动实时 Trace，SessionDB 历史仍会按可用状态显示。</span></div>
          )}
          {!trace ? (
            <EmptyState hermes={settings?.hermes} onRun={() => setModal("run")} onImport={() => { void loadSessions().then(() => setModal("import")); }} />
          ) : (
            <>
              <div className={`trace-header-shell ${traceHeaderCollapsed ? "collapsed" : ""}`}>
                <div className="trace-header trace-header-expanded">
                  <div className="trace-title-block"><div className="trace-title-line"><StatusPill status={trace.status} /><span className="trace-source">{trace.captureMode === "history" ? "SESSIONDB" : trace.captureCompleteness === "full" ? "GATEWAY + OBSERVER" : "HERMES GATEWAY"}</span></div><h1>{trace.title}</h1><p><Code2 size={14} /> {trace.cwd || "未绑定工作目录"}</p></div>
                  <div className="trace-metrics">
                    <div><Clock3 size={15} /><span><small>DURATION</small><strong>{formatDuration(trace.durationMs)}</strong></span></div>
                    <div><Activity size={15} /><span><small>EVENTS</small><strong>{trace.eventCount}</strong></span></div>
                    <div><TerminalSquare size={15} /><span><small>TOOLS</small><strong>{trace.toolCallCount}</strong></span></div>
                    <div><Zap size={15} /><span><small>TOKENS</small><strong>{compactNumber(trace.inputTokens + trace.outputTokens)}</strong></span></div>
                  </div>
                  {isRunning && <button className="stop-button" onClick={stopRun} type="button"><Square size={13} fill="currentColor" /> 中断</button>}
                </div>
                <div className="trace-header-compact"><StatusPill status={trace.status} /><strong>{trace.title}</strong><span><Clock3 size={13} /> {formatDuration(trace.durationMs)}</span><span><Activity size={13} /> {trace.eventCount} 事件</span></div>
                <button className="trace-header-toggle" onClick={() => setTraceHeaderCollapsed((value) => !value)} type="button" aria-expanded={!traceHeaderCollapsed} aria-label={traceHeaderCollapsed ? "展开 Trace 概要" : "收起 Trace 概要"}><ChevronDown className="trace-collapse-chevron" size={16} /><span>{traceHeaderCollapsed ? "展开摘要" : "收起摘要"}</span></button>
              </div>

              {trace.errorMessage && <div className="trace-error"><OctagonX size={17} /><span>{trace.errorMessage}</span></div>}

              <div className="view-toolbar">
                <div className="segmented">
                  <button className={view === "overview" ? "active" : ""} onClick={() => void selectView("overview")} type="button"><BarChart3 size={15} /> 总览</button>
                  <button className={view === "timeline" ? "active" : ""} onClick={() => void selectView("timeline")} type="button"><ListTree size={15} /> 时间线</button>
                  <button className={view === "graph" ? "active" : ""} onClick={() => void selectView("graph")} type="button"><GitBranch size={15} /> 流程图</button>
                  <button className={view === "calls" ? "active" : ""} onClick={() => void selectView("calls")} type="button"><Table2 size={15} /> 工具与调用</button>
                  <button className={view === "prompt" ? "active" : ""} onClick={() => void selectView("prompt")} type="button"><Layers3 size={15} /> Prompt</button>
                  <button className={view === "raw" ? "active" : ""} onClick={() => void selectView("raw")} type="button"><Braces size={15} /> 原始数据</button>
                </div>
                {view === "timeline" && <div className="filter-strip"><Filter size={14} /><button className={category === "all" ? "active" : ""} onClick={() => setCategory("all")} type="button">全部</button>{categories.map((item) => <button className={category === item ? "active" : ""} key={item} onClick={() => setCategory(item)} type="button">{metaFor(item).label}</button>)}</div>}
              </div>

              <div className={`trace-view view-${view}`}>
                {view === "overview" && <TraceOverview events={events} onSelect={setSelectedEvent} trace={trace} />}
                {view === "timeline" && <Timeline category={category} events={events} onSelect={setSelectedEvent} selectedId={selectedEvent?.id} />}
                {view === "graph" && <TraceGraph events={events} onSelect={setSelectedEvent} />}
                {view === "calls" && <CallsView events={events} onSelect={setSelectedEvent} />}
                {view === "prompt" && <PromptView layers={trace.promptLayers || []} />}
                {view === "raw" && <RawView events={rawEvents} loading={rawLoading} />}
              </div>
            </>
          )}
        </section>

        {selectedEvent && <Inspector event={selectedEvent} onClose={() => setSelectedEvent(undefined)} />}
      </div>

      {modal === "run" && <RunModal busy={busy} error={error} onClose={() => setModal(null)} onSubmit={startRun} settings={settings} />}
      {modal === "import" && <ImportModal busy={busy} error={error} onClose={() => setModal(null)} onImport={importSession} onRefresh={() => void loadSessions()} sessions={sessions} />}
    </main>
  );
}
