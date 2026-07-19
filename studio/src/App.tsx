import {
  AppWindow,
  ArrowDownAZ,
  ArrowLeft,
  BookOpen,
  Bot,
  Boxes,
  Check,
  CircleAlert,
  CirclePlus,
  CloudDownload,
  Code2,
  Command,
  Copy,
  Download,
  Eye,
  FolderHeart,
  History,
  Home,
  Info,
  LayoutGrid,
  LoaderCircle,
  Maximize2,
  MessageSquareText,
  Monitor,
  MoreHorizontal,
  Palette,
  PenTool,
  PlugZap,
  Plus,
  RotateCcw,
  Search,
  Send,
  Settings,
  Sparkles,
  SwatchBook,
  Terminal,
  Trash2,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "motion/react";
import {
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  Suspense,
  lazy,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import componentRegistry from "../../plugins/trae/resources/components.v1.json";

import {
  type CatalogEntry,
  type LocalTheme,
  type ThemeCategory,
} from "./catalog";
import {
  type AgentConnection,
  type AgentDto,
  type InspectDto,
  type PluginDto,
  type RuntimeStatusDto,
  type StudioSettings,
  ApiError,
  studioApi,
} from "./api";
import type { ThemePreviewScene } from "./ThemeShowcase";
import { type AppearanceMode, type StudioTheme } from "./themes";

const ThemeScenePreview = lazy(() => import("./ThemeShowcase").then((module) => ({
  default: module.ThemeScenePreview,
})));

type View = "center" | "library" | "connections" | "settings" | "workspace";
type CenterScope = "discover" | "mine";
type ThemeSort = "recent" | "name";
type ToastTone = "success" | "error" | "info";
type Toast = { id: number; title: string; detail: string; tone: ToastTone };
type ChatMessage = {
  id: number;
  role: "assistant" | "user";
  text: string;
  changes?: string[];
};

const categories: Array<"全部" | ThemeCategory> = [
  "全部",
  "精选",
  "明星",
  "美景",
  "动漫",
  "游戏",
  "极简",
  "科技",
  "国风",
];

const sceneOptions: Array<{ value: ThemePreviewScene; label: string; icon: ReactNode }> = [
  { value: "work", label: "Work", icon: <BookOpen size={14} /> },
  { value: "code", label: "Code", icon: <Code2 size={14} /> },
  { value: "design", label: "Design", icon: <Palette size={14} /> },
  { value: "thread", label: "对话页", icon: <MessageSquareText size={14} /> },
  { value: "components", label: "组件", icon: <Boxes size={14} /> },
];

const previewZoomLevels = [1, 1.25, 1.5, 2] as const;

const componentLabels: Record<string, string> = {
  "shell.workspace": "工作区",
  "mode.switcher": "模式切换",
  "sidebar.task": "侧栏任务项",
  "sidebar.utility": "侧栏图标",
  "composer.surface": "输入区",
  "action.primary": "主要操作",
  "message.user": "用户消息",
  "tooltip.surface": "提示",
  "menu.surface": "菜单",
  "menu.item": "菜单项",
  "dialog.surface": "对话框",
  "home.title": "首页标题",
  "home.showcase": "首页卡片",
  "home.sceneTab": "场景标签",
  "home.scenePanel": "场景面板",
  "home.sceneCard": "场景卡片",
  "input.field": "输入框",
  "selection.control": "选择控件",
  "status.badge": "状态标记",
  "toast.surface": "通知",
};

const componentNames = new Map(
  componentRegistry.components.map((component) => [component.id, componentLabels[component.id] || component.id]),
);

const disconnectedConnection: AgentConnection = { agentId: null, state: "disconnected" };
const defaultSettings: StudioSettings = {
  themesRoot: "",
  autoVerify: true,
  motionEnabled: true,
};

function connectionIsReady(connection: AgentConnection) {
  return Boolean(connection.agentId) && connection.state === "connected";
}

function agentInitial(agent?: AgentDto) {
  return agent?.initial || agent?.name.trim().charAt(0).toUpperCase() || "?";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "发生了未知错误。";
}

function putTheme(items: LocalTheme[], updated: LocalTheme) {
  const index = items.findIndex((item) => item.localId === updated.localId);
  if (index === -1) return [updated, ...items];
  return items.map((item) => item.localId === updated.localId ? updated : item);
}

function targetNameFromId(targetId: string) {
  if (!targetId) return "目标应用";
  return targetId.charAt(0).toUpperCase() + targetId.slice(1);
}

function initialThemeMessages(item: LocalTheme): ChatMessage[] {
  return [{
    id: 1,
    role: "assistant",
    text: item.origin === "blank"
      ? "空白主题已经准备好了。告诉我你想要的氛围、色彩或视觉题材，我会从背景、组件和状态开始生成。"
      : `我已经载入 ${item.theme.name}。你可以直接描述修改，也可以在右侧点选一个组件。`,
  }];
}

function IconButton({
  label,
  children,
  onClick,
  active = false,
  disabled = false,
  className = "",
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-button tooltip ${active ? "is-active" : ""} ${className}`}
      aria-label={label}
      data-tooltip={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function AppRail({ view, agent, connection, onNavigate }: { view: View; agent?: AgentDto; connection: AgentConnection; onNavigate: (view: View) => void }) {
  const item = (target: View, label: string, icon: ReactNode) => (
    <button
      type="button"
      className={`rail-button tooltip ${view === target || (target === "library" && view === "workspace") ? "is-active" : ""}`}
      aria-label={label}
      aria-current={view === target || (target === "library" && view === "workspace") ? "page" : undefined}
      data-tooltip={label}
      onClick={() => onNavigate(target)}
    >
      {icon}
    </button>
  );

  return (
    <nav className="app-rail" aria-label="主导航">
      <button className="brand-mark" type="button" aria-label="DreamSkin Studio" onClick={() => onNavigate("center")}>
        <SwatchBook size={21} />
      </button>
      <div className="rail-actions">
        {item("center", "主题中心", <Home size={19} />)}
        {item("library", "我的主题", <FolderHeart size={19} />)}
        {item("connections", "Agent 连接", <PlugZap size={19} />)}
      </div>
      <div className="rail-spacer" />
      {item("settings", "设置", <Settings size={19} />)}
      <button className="agent-avatar tooltip" type="button" aria-label={agent && connectionIsReady(connection) ? `${agent.name}，已连接` : "Agent 未连接"} data-tooltip={agent && connectionIsReady(connection) ? `${agent.name} · 已连接` : "Agent 未连接"} onClick={() => onNavigate("connections")}>
        {agentInitial(agent)}{agent && connectionIsReady(connection) ? <span /> : null}
      </button>
    </nav>
  );
}

function WindowBar({
  view,
  workspaceTheme,
  agent,
  connection,
  onNavigate,
  onCreateTheme,
  createDisabled,
}: {
  view: View;
  workspaceTheme?: LocalTheme;
  agent?: AgentDto;
  connection: AgentConnection;
  onNavigate: (view: View) => void;
  onCreateTheme: () => void;
  createDisabled: boolean;
}) {
  const connected = agent && connectionIsReady(connection);
  return (
    <header className="window-bar">
      <div className="traffic-lights" aria-hidden="true"><i /><i /><i /></div>
      <div className="workspace-tabs" role="group" aria-label="工作区标签">
        <button type="button" className={view === "center" ? "is-active" : ""} aria-pressed={view === "center"} onClick={() => onNavigate("center")}>
          <Home size={13} /><span>主题中心</span>
        </button>
        {workspaceTheme ? (
          <button type="button" className={view === "workspace" ? "is-active" : ""} aria-pressed={view === "workspace"} onClick={() => onNavigate("workspace")}>
            <FolderHeart size={13} /><span>{workspaceTheme.theme.name}</span>
          </button>
        ) : null}
        <button type="button" className="tab-add tooltip" aria-label="新建空白主题" data-tooltip="新建空白主题" disabled={createDisabled} onClick={onCreateTheme}><Plus size={14} /></button>
      </div>
      <div className="window-actions">
        <button className="agent-pill" type="button" aria-label={connected ? `${agent.name}，ACP 已连接` : "连接本地 Agent"} onClick={() => onNavigate("connections")}>
          {connected ? <span className="online-dot" /> : null}<Command size={14} /><strong>{connected ? agent.name : "未连接 Agent"}</strong><small>ACP</small>
        </button>
        <IconButton label="设置" onClick={() => onNavigate("settings")}><Settings size={16} /></IconButton>
      </div>
    </header>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={option.value === value ? "is-selected" : ""}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ThemeArtwork({ theme, compact = false }: { theme: StudioTheme; compact?: boolean }) {
  return (
    <div
      className={`theme-artwork ${compact ? "is-compact" : ""} ${theme.imageUrl ? "" : "is-blank"}`}
      style={{
        "--art-accent": theme.colors.accent,
        "--art-panel": theme.colors.panel,
        "--art-text": theme.colors.text,
        backgroundColor: theme.colors.background,
        backgroundImage: theme.imageUrl ? `url(${theme.imageUrl})` : undefined,
      } as CSSProperties}
    >
      <div className="art-window">
        <div className="art-sidebar"><i /><span /><span /><span /></div>
        <div className="art-content"><b /><span /><span /><i className="art-action" /></div>
      </div>
    </div>
  );
}

function TemplateCard({
  entry,
  local,
  onAdd,
  onOpen,
  onInspect,
}: {
  entry: CatalogEntry;
  local?: LocalTheme;
  onAdd: () => void;
  onOpen: () => void;
  onInspect: () => void;
}) {
  return (
    <article className="template-card">
      <button className="template-preview" type="button" onClick={onInspect} aria-label={`查看 ${entry.theme.name}`}>
        <ThemeArtwork theme={entry.theme} />
        <span className="target-badge"><Command size={11} />{entry.target || targetNameFromId(entry.targetId)}</span>
        {entry.theme.experimental ? <span className="beta-badge">Beta</span> : null}
      </button>
      <div className="template-meta">
        <div><strong>{entry.theme.name}</strong><span>{entry.author}</span></div>
        <button className={local ? "open-theme-button" : "download-theme-button"} type="button" onClick={local ? onOpen : onAdd}>
          {local ? <Eye size={14} /> : <CloudDownload size={14} />}
          <span>{local ? "打开" : "添加"}</span>
        </button>
      </div>
      <div className="template-foot"><span>{entry.categories.slice(0, 2).join(" · ")}</span><span>{entry.downloads}</span></div>
    </article>
  );
}

function FeaturedCard({
  entry,
  local,
  onAdd,
  onOpen,
}: {
  entry: CatalogEntry;
  local?: LocalTheme;
  onAdd: () => void;
  onOpen: () => void;
}) {
  return (
    <article
      className="featured-card"
      style={{ backgroundImage: `url(${entry.theme.imageUrl})`, "--feature-accent": entry.theme.colors.accent } as CSSProperties}
    >
      <div className="featured-scrim" />
      <div className="featured-copy">
        <span><Command size={12} />{entry.target || targetNameFromId(entry.targetId)} 精选</span>
        <strong>{entry.theme.name}</strong>
        <p>{entry.theme.description}</p>
        <button type="button" onClick={local ? onOpen : onAdd}>
          {local ? <Eye size={15} /> : <CloudDownload size={15} />}{local ? "打开编辑" : "添加到我的主题"}
        </button>
      </div>
      <div className="featured-mini-ui"><ThemeArtwork theme={entry.theme} compact /></div>
    </article>
  );
}

function BlankThemeCard({ onCreate, wide = false }: { onCreate: () => void; wide?: boolean }) {
  return (
    <button className={`blank-theme-card ${wide ? "is-wide" : ""}`} type="button" onClick={onCreate}>
      <span className="blank-grid"><CirclePlus size={27} /></span>
      <span><strong>新建空白主题</strong><small>与 Agent 对话生成</small></span>
    </button>
  );
}

function LocalThemeCard({
  item,
  targetName,
  onOpen,
  onDuplicate,
  onDelete,
}: {
  item: LocalTheme;
  targetName: string;
  onOpen: () => void;
  onDuplicate: () => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const menuId = useId();
  const labelId = `${menuId}-delete-label`;
  const descriptionId = `${menuId}-delete-description`;
  const actionsRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busyAction, setBusyAction] = useState<"duplicate" | "delete" | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const focusFrame = window.requestAnimationFrame(() => {
      (confirmDelete ? cancelDeleteRef.current : firstActionRef.current)?.focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      if (!actionsRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
        setConfirmDelete(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
        setConfirmDelete(false);
        triggerRef.current?.focus();
        return;
      }
      if (confirmDelete && event.key === "Tab") {
        const items = [...(actionsRef.current?.querySelectorAll<HTMLButtonElement>(".theme-delete-actions button:not(:disabled)") || [])];
        if (!items.length) return;
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.shiftKey
          ? current <= 0 ? items.length - 1 : current - 1
          : current === -1 || current >= items.length - 1 ? 0 : current + 1;
        event.preventDefault();
        items[next]?.focus();
        return;
      }
      if (confirmDelete || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = [...(actionsRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || [])];
      if (!items.length) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0
        : event.key === "End" ? items.length - 1
          : event.key === "ArrowDown" ? (current + 1 + items.length) % items.length
            : (current - 1 + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [confirmDelete, menuOpen]);

  const duplicate = async () => {
    let succeeded = false;
    setBusyAction("duplicate");
    try {
      succeeded = await onDuplicate();
      if (succeeded) setMenuOpen(false);
    } finally {
      setBusyAction(null);
      if (succeeded) window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  };

  const deleteTheme = async () => {
    setBusyAction("delete");
    try {
      if (await onDelete()) {
        setMenuOpen(false);
        setConfirmDelete(false);
      }
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <article className="local-theme-card">
      <button type="button" className="local-theme-preview" aria-label={`打开 ${item.theme.name}`} onClick={onOpen}>
        <ThemeArtwork theme={item.theme} />
        <span className={`local-status is-${item.status}`}><i />{item.status === "applied" ? "使用中" : item.status === "verified" ? "已验证" : "草稿"}</span>
      </button>
      <div className="local-theme-meta">
        <div><strong>{item.theme.name}</strong><span>{targetName} · v{item.revision}</span></div>
        <div className="local-theme-actions" ref={actionsRef}>
          <button
            ref={triggerRef}
            className="local-theme-more tooltip"
            type="button"
            aria-label={`${item.theme.name} 的更多操作`}
            aria-controls={menuOpen ? menuId : undefined}
            aria-expanded={menuOpen}
            aria-haspopup={confirmDelete ? "dialog" : "menu"}
            data-tooltip="更多操作"
            disabled={Boolean(busyAction)}
            onClick={() => {
              setMenuOpen((open) => !open);
              setConfirmDelete(false);
            }}
          >
            <MoreHorizontal size={16} />
          </button>
          {menuOpen ? confirmDelete ? (
            <div
              className="theme-delete-confirm"
              id={menuId}
              role="alertdialog"
              aria-busy={busyAction === "delete"}
              aria-labelledby={labelId}
              aria-describedby={descriptionId}
            >
              <div className="theme-delete-heading"><span><Trash2 size={14} /></span><strong id={labelId}>删除主题？</strong></div>
              <p id={descriptionId}>“{item.theme.name}”删除后无法恢复。</p>
              <div className="theme-delete-actions">
                <button ref={cancelDeleteRef} type="button" disabled={Boolean(busyAction)} onClick={() => setConfirmDelete(false)}>取消</button>
                <button className="is-danger" type="button" disabled={Boolean(busyAction)} onClick={deleteTheme}>{busyAction === "delete" ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}删除</button>
              </div>
            </div>
          ) : (
            <div className="theme-action-menu" id={menuId} role="menu" aria-label={`${item.theme.name} 操作`} aria-busy={busyAction === "duplicate"}>
              <button ref={firstActionRef} type="button" role="menuitem" disabled={Boolean(busyAction)} onClick={duplicate}>{busyAction === "duplicate" ? <LoaderCircle className="spin" size={14} /> : <Copy size={14} />}<span>复制主题</span></button>
              <span className="theme-action-separator" aria-hidden="true" />
              <button className="is-danger" type="button" role="menuitem" disabled={Boolean(busyAction)} onClick={() => setConfirmDelete(true)}><Trash2 size={14} /><span>删除主题</span></button>
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function PageHeading({ title, meta, action }: { title: string; meta: string; action?: ReactNode }) {
  return <div className="page-heading"><div><h1>{title}</h1><span>{meta}</span></div>{action}</div>;
}

function ThemeCenter({
  catalog,
  localThemes,
  targetNameForTheme,
  onAdd,
  onOpen,
  onDuplicate,
  onDelete,
  onCreateBlank,
  onInspect,
  onLibrary,
}: {
  catalog: CatalogEntry[];
  localThemes: LocalTheme[];
  targetNameForTheme: (theme: LocalTheme) => string;
  onAdd: (entry: CatalogEntry) => void;
  onOpen: (id: string) => void;
  onDuplicate: (theme: LocalTheme) => Promise<boolean>;
  onDelete: (theme: LocalTheme) => Promise<boolean>;
  onCreateBlank: () => void;
  onInspect: (entry: CatalogEntry) => void;
  onLibrary: () => void;
}) {
  const [scope, setScope] = useState<CenterScope>("discover");
  const [category, setCategory] = useState<"全部" | ThemeCategory>("全部");
  const [query, setQuery] = useState("");
  const [targetId, setTargetId] = useState("all");
  const targets = [...new Map(catalog.map((entry) => [entry.targetId, entry.target || targetNameFromId(entry.targetId)])).entries()];
  const targetSummary = targets.map(([, name]) => name).join(" · ") || "暂无目标";
  const normalizedQuery = query.trim().toLowerCase();
  const localFor = (entry: CatalogEntry) => localThemes.find((item) => (
    item.pluginId === entry.pluginId && item.sourceId === entry.theme.id
  ));
  const targetLocalThemes = localThemes.filter((item) => targetId === "all" || item.targetId === targetId);
  const visibleLocalThemes = targetLocalThemes.filter((item) => (
    !normalizedQuery
    || `${item.theme.name} ${item.theme.description} ${targetNameForTheme(item)}`.toLowerCase().includes(normalizedQuery)
  ));
  const recentLocalThemes = [...targetLocalThemes].sort((left, right) => (
    (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0)
    || right.revision - left.revision
  ));
  const featuredEntries = catalog.filter((entry) => (
    entry.featured && (targetId === "all" || entry.targetId === targetId)
  )).slice(0, 2);
  const filtered = catalog.filter((entry) => {
    const matchesTarget = targetId === "all" || entry.targetId === targetId;
    const matchesCategory = category === "全部" || entry.categories.includes(category);
    const matchesQuery = `${entry.theme.name} ${entry.theme.description} ${entry.author} ${entry.categories.join(" ")}`.toLowerCase().includes(normalizedQuery);
    return matchesTarget && matchesCategory && matchesQuery;
  });

  return (
    <main className="page-scroll">
      <div className="content-width">
        <PageHeading
          title="主题中心"
          meta={`${targetSummary} · ${catalog.length} 个可用主题`}
          action={<label className="global-search"><Search size={16} /><input aria-label="搜索主题" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索主题" />{query ? <button type="button" aria-label="清除搜索" onClick={() => setQuery("")}><X size={14} /></button> : null}</label>}
        />

        <div className="catalog-toolbar">
          <Segmented
            value={scope}
            onChange={setScope}
            label="主题中心范围"
            options={[
              { value: "discover", label: "发现" },
              { value: "mine", label: "我的主题" },
            ]}
          />
          <div className="target-tabs" role="group" aria-label="目标应用"><span>目标</span>{targets.length > 1 ? <button type="button" className={targetId === "all" ? "is-active" : ""} aria-pressed={targetId === "all"} onClick={() => setTargetId("all")}>全部</button> : null}{targets.map(([id, name]) => <button type="button" className={targetId === id || targets.length === 1 ? "is-active" : ""} aria-pressed={targetId === id || targets.length === 1} key={id} onClick={() => setTargetId(id)}><Command size={13} />{name}</button>)}</div>
        </div>

        {scope === "discover" ? (
          <>
            <div className="category-strip" role="group" aria-label="主题分类">
              {categories.map((item) => <button type="button" key={item} className={item === category ? "is-active" : ""} aria-pressed={item === category} onClick={() => setCategory(item)}>{item}</button>)}
            </div>

            {!query && category === "全部" && featuredEntries.length ? (
              <section className="content-section">
                <div className="section-heading"><div><strong>本周精选</strong><span>由 DreamSkin 编辑推荐</span></div><span className="section-count">{String(featuredEntries.length).padStart(2, "0")}</span></div>
                <div className="featured-grid">
                  {featuredEntries.map((entry) => {
                    const local = localFor(entry);
                    return <FeaturedCard key={`${entry.pluginId}:${entry.theme.id}`} entry={entry} local={local} onAdd={() => onAdd(entry)} onOpen={() => local && onOpen(local.localId)} />;
                  })}
                </div>
              </section>
            ) : null}

            {!query && category === "全部" ? (
              <section className="content-section mine-shelf">
                <div className="section-heading"><div><strong>我的主题</strong><span>最近编辑</span></div><button type="button" onClick={onLibrary}>查看全部</button></div>
                <div className="mine-row">
                  <BlankThemeCard onCreate={onCreateBlank} />
                  {recentLocalThemes.slice(0, 3).map((item) => <LocalThemeCard key={item.localId} item={item} targetName={targetNameForTheme(item)} onOpen={() => onOpen(item.localId)} onDuplicate={() => onDuplicate(item)} onDelete={() => onDelete(item)} />)}
                </div>
              </section>
            ) : null}

            <section className="content-section">
              <div className="section-heading"><div><strong>{category === "全部" ? "全部模板" : category}</strong><span>{filtered.length} 个主题</span></div></div>
              <div className="template-grid">
                {filtered.map((entry) => {
                  const local = localFor(entry);
                  return <TemplateCard key={`${entry.pluginId}:${entry.theme.id}`} entry={entry} local={local} onAdd={() => onAdd(entry)} onOpen={() => local && onOpen(local.localId)} onInspect={() => onInspect(entry)} />;
                })}
              </div>
              {!filtered.length ? <div className="catalog-empty"><Search size={18} /><strong>没有匹配的模板</strong><span>换个关键词、分类或目标试试。</span></div> : null}
            </section>
          </>
        ) : (
          <section className="content-section scope-library">
            <div className="section-heading"><div><strong>我的主题</strong><span>{visibleLocalThemes.length} 个主题</span></div></div>
            <div className="library-grid">
              <BlankThemeCard onCreate={onCreateBlank} wide />
              {visibleLocalThemes.map((item) => <LocalThemeCard key={item.localId} item={item} targetName={targetNameForTheme(item)} onOpen={() => onOpen(item.localId)} onDuplicate={() => onDuplicate(item)} onDelete={() => onDelete(item)} />)}
            </div>
            {!visibleLocalThemes.length && normalizedQuery ? <div className="catalog-empty"><Search size={18} /><strong>没有匹配的本地主题</strong><span>清除搜索后可查看全部主题。</span></div> : null}
          </section>
        )}
      </div>
    </main>
  );
}

function MyThemes({
  localThemes,
  targetNameForTheme,
  onCreateBlank,
  onOpen,
  onDuplicate,
  onDelete,
}: {
  localThemes: LocalTheme[];
  targetNameForTheme: (theme: LocalTheme) => string;
  onCreateBlank: () => void;
  onOpen: (id: string) => void;
  onDuplicate: (theme: LocalTheme) => Promise<boolean>;
  onDelete: (theme: LocalTheme) => Promise<boolean>;
}) {
  const [targetId, setTargetId] = useState("all");
  const [sort, setSort] = useState<ThemeSort>("recent");
  const targets = [...new Map(localThemes.map((item) => [item.targetId, targetNameForTheme(item)])).entries()];
  useEffect(() => {
    if (targetId !== "all" && !localThemes.some((item) => item.targetId === targetId)) setTargetId("all");
  }, [localThemes, targetId]);
  const filteredThemes = targetId === "all" ? localThemes : localThemes.filter((item) => item.targetId === targetId);
  const visibleThemes = [...filteredThemes].sort((left, right) => {
    if (sort === "name") {
      return left.theme.name.localeCompare(right.theme.name, "zh-CN", { numeric: true, sensitivity: "base" });
    }
    const byUpdated = (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0);
    return byUpdated || right.revision - left.revision || left.theme.name.localeCompare(right.theme.name, "zh-CN");
  });
  return (
    <main className="page-scroll">
      <div className="content-width">
        <PageHeading title="我的主题" meta={`${localThemes.length} 个本地主题`} action={<button className="primary-button" type="button" onClick={onCreateBlank}><CirclePlus size={16} />新建空白主题</button>} />
        <div className="library-filter-row"><div role="group" aria-label="目标应用筛选"><button type="button" className={targetId === "all" ? "is-active" : ""} aria-pressed={targetId === "all"} onClick={() => setTargetId("all")}>全部</button>{targets.map(([id, name]) => <button type="button" className={targetId === id ? "is-active" : ""} aria-pressed={targetId === id} key={id} onClick={() => setTargetId(id)}>{name}</button>)}</div><div className="library-sort" role="group" aria-label="主题排序"><button type="button" className={sort === "recent" ? "is-active" : ""} aria-pressed={sort === "recent"} onClick={() => setSort("recent")}><History size={13} />最近修改</button><button type="button" className={sort === "name" ? "is-active" : ""} aria-pressed={sort === "name"} onClick={() => setSort("name")}><ArrowDownAZ size={13} />名称</button></div></div>
        <div className="library-grid page-library-grid">
          <BlankThemeCard onCreate={onCreateBlank} wide />
          {visibleThemes.map((item) => <LocalThemeCard key={item.localId} item={item} targetName={targetNameForTheme(item)} onOpen={() => onOpen(item.localId)} onDuplicate={() => onDuplicate(item)} onDelete={() => onDelete(item)} />)}
        </div>
      </div>
    </main>
  );
}

function Connections({
  agents,
  connection,
  onConnect,
  onRefresh,
}: {
  agents: AgentDto[];
  connection: AgentConnection;
  onConnect: (id: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [connectBusy, setConnectBusy] = useState<string | null>(null);
  const connectedAgent = agents.find((agent) => agent.id === connection.agentId);
  const connected = connectedAgent && connectionIsReady(connection);

  const refresh = async () => {
    setRefreshBusy(true);
    try {
      await onRefresh();
    } finally {
      setRefreshBusy(false);
    }
  };

  const connect = async (id: string) => {
    setConnectBusy(id);
    try {
      await onConnect(id);
    } finally {
      setConnectBusy(null);
    }
  };

  return (
    <main className="page-scroll">
      <div className="content-width narrow-content">
        <PageHeading title="Agent 连接" meta="ACP 本地连接" />
        <section className="connection-summary"><div className="connection-orbit"><Command size={22} />{connected ? <span /> : null}</div><div><strong>{connectedAgent?.name || "未连接 Agent"}</strong><span>{connected ? "DreamSkin Tool 已就绪" : connection.state === "error" ? "ACP 连接失败" : "请选择本地 CLI Agent"}</span></div><span className={`connected-label ${connected ? "" : "is-offline"}`}>{connected ? <><i />已连接</> : "未连接"}</span></section>
        <section className="settings-section">
          <div className="section-heading"><div><strong>本机 Agent</strong><span>自动检测</span></div><button type="button" onClick={refresh} disabled={refreshBusy}><RotateCcw className={refreshBusy ? "spin" : ""} size={14} />{refreshBusy ? "扫描中" : "重新扫描"}</button></div>
          <div className="agent-list">
            {agents.map((agent) => {
              const isConnected = agent.id === connection.agentId && connectionIsReady(connection);
              const connecting = connectBusy === agent.id;
              const initial = agentInitial(agent);
              const unsupported = agent.state === "unsupported" || agent.capabilities?.acp === false;
              return (
                <div className="agent-row" key={agent.id}>
                  <span className={`agent-logo agent-${initial.toLowerCase()}`}>{initial}</span>
                  <div><strong>{agent.name}</strong><span><Terminal size={12} />{agent.command}{agent.version ? ` · ${agent.version}` : ""}</span></div>
                  {agent.state === "missing" ? <button type="button" className="secondary-button" disabled>未安装</button> : unsupported ? <button type="button" className="secondary-button" disabled>不支持 ACP</button> : isConnected ? <span className="row-status"><i />已连接</span> : <button type="button" className="secondary-button" disabled={Boolean(connectBusy)} onClick={() => connect(agent.id)}>{connecting ? <LoaderCircle className="spin" size={14} /> : null}{connecting ? "连接中" : "连接"}</button>}
                </div>
              );
            })}
            {!agents.length ? <div className="agent-row"><span className="agent-logo">?</span><div><strong>未检测到 CLI Agent</strong><span><Terminal size={12} />请重新扫描本机环境</span></div></div> : null}
          </div>
        </section>
      </div>
    </main>
  );
}

function SettingsView({
  settings,
  inspect,
  runtime,
  targetName,
  onChange,
  onVerifyRuntime,
  onRestoreRuntime,
}: {
  settings: StudioSettings;
  inspect: InspectDto | null;
  runtime: RuntimeStatusDto | null;
  targetName: string;
  onChange: (patch: Partial<Pick<StudioSettings, "autoVerify" | "motionEnabled">>) => Promise<void>;
  onVerifyRuntime: () => Promise<void>;
  onRestoreRuntime: () => Promise<void>;
}) {
  const [autoVerify, setAutoVerify] = useState(settings.autoVerify);
  const [motionEnabled, setMotionEnabled] = useState(settings.motionEnabled);
  const [busy, setBusy] = useState<"autoVerify" | "motionEnabled" | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState<"verify" | "restore" | null>(null);
  useEffect(() => {
    setAutoVerify(settings.autoVerify);
    setMotionEnabled(settings.motionEnabled);
  }, [settings.autoVerify, settings.motionEnabled]);
  const update = async (key: "autoVerify" | "motionEnabled", value: boolean) => {
    setBusy(key);
    try {
      await onChange({ [key]: value });
    } finally {
      setBusy(null);
    }
  };
  const runtimeLabel = runtime?.available === false || runtime?.session === "unsupported"
    ? "不可用"
    : runtime?.session === "active"
      ? "已连接"
      : runtime?.session
        ? "待连接"
        : "未知";
  const runtimeActive = runtime?.session === "active";
  const runRuntimeAction = async (action: "verify" | "restore") => {
    setRuntimeBusy(action);
    try {
      if (action === "verify") await onVerifyRuntime();
      else await onRestoreRuntime();
    } finally {
      setRuntimeBusy(null);
    }
  };
  return (
    <main className="page-scroll">
      <div className="content-width narrow-content">
        <PageHeading title="设置" meta="DreamSkin Studio" />
        <section className="settings-section">
          <div className="settings-title"><strong>主题工作台</strong></div>
          <div className="setting-row"><span><strong>自动验证</strong><small>Agent 修改完成后验证主题结构</small></span><button type="button" className={`toggle ${autoVerify ? "is-on" : ""}`} role="switch" disabled={Boolean(busy)} aria-label="自动验证" aria-checked={autoVerify} onClick={() => update("autoVerify", !autoVerify)}><i /></button></div>
          <div className="setting-row"><span><strong>界面动效</strong><small>主题卡片与工作台过渡</small></span><button type="button" className={`toggle ${motionEnabled ? "is-on" : ""}`} role="switch" disabled={Boolean(busy)} aria-label="界面动效" aria-checked={motionEnabled} onClick={() => update("motionEnabled", !motionEnabled)}><i /></button></div>
          <div className="setting-row"><span><strong>主题存储位置</strong><small>{settings.themesRoot || "未配置"}</small></span></div>
        </section>
        <section className="settings-section"><div className="settings-title"><strong>运行状态</strong></div><div className="diagnostic-row"><span><i />DreamSkin Tool</span><strong>{inspect?.agentToolVersion || "未知"}</strong></div><div className="diagnostic-row"><span><i />{targetName} Runtime</span><strong>{runtimeLabel}</strong></div><div className="diagnostic-row"><span><i />组件注册表</span><strong>{inspect?.registry?.components?.length ?? componentRegistry.components.length} 项</strong></div><button type="button" className="setting-row command-row" disabled={!runtimeActive || Boolean(runtimeBusy)} onClick={() => runRuntimeAction("verify")}><span><strong>验证当前主题</strong><small>检查 {targetName} 中的实际换肤结果</small></span>{runtimeBusy === "verify" ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}</button><button type="button" className="setting-row command-row" disabled={!runtimeActive || Boolean(runtimeBusy)} onClick={() => runRuntimeAction("restore")}><span><strong>恢复原生界面</strong><small>停止当前主题并恢复 {targetName}</small></span>{runtimeBusy === "restore" ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}</button></section>
      </div>
    </main>
  );
}

function ChatPane({
  theme,
  agent,
  connection,
  messages,
  selectedComponent,
  busy,
  locked,
  onSend,
  onClearComponent,
}: {
  theme: LocalTheme;
  agent?: AgentDto;
  connection: AgentConnection;
  messages: ChatMessage[];
  selectedComponent: string | null;
  busy: boolean;
  locked: boolean;
  onSend: (prompt: string) => void;
  onClearComponent: () => void;
}) {
  const [input, setInput] = useState("");
  const connected = agent && connectionIsReady(connection);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!input.trim() || locked || !connected) return;
    onSend(input.trim());
    setInput("");
  };
  const suggestions = theme.origin === "blank"
    ? ["生成一套深色赛博朋克主题", "做成明亮的手绘动漫风格", "我想要克制的纸张编辑感"]
    : ["图标改成印章风格", "让选中状态更明显", "面板增加玻璃质感"];

  return (
    <aside className="chat-pane">
      <header className="chat-heading"><div className={`agent-logo agent-${agentInitial(agent).toLowerCase()}`} aria-hidden="true">{agentInitial(agent)}{connected ? <span /> : null}</div><div><strong>{agent?.name || "未连接 Agent"}</strong><span>{connected ? <><i />ACP Session · {theme.theme.name}</> : "请先连接本地 CLI Agent"}</span></div></header>
      <div className="chat-messages" aria-live="polite" aria-busy={busy}>
        {messages.map((message) => (
          <article key={message.id} className={`chat-message is-${message.role}`}>
            {message.role === "assistant" ? <span className="message-agent"><Sparkles size={14} /></span> : null}
            <div><p>{message.text}</p>{message.changes?.length ? <div className="change-list">{message.changes.map((change) => <span key={change}><Check size={12} />{change}</span>)}</div> : null}</div>
          </article>
        ))}
        {busy ? <article className="chat-message is-assistant is-thinking"><span className="message-agent"><LoaderCircle size={14} /></span><div><p>正在检查主题结构并生成修改...</p><span>读取 visualSlots</span></div></article> : null}
      </div>
      <div className="prompt-suggestions">{suggestions.map((suggestion) => <button type="button" key={suggestion} onClick={() => onSend(suggestion)} disabled={locked || !connected}>{suggestion}</button>)}</div>
      <form className="chat-composer" onSubmit={submit}>
        {selectedComponent ? <div className="context-chip"><Boxes size={13} /><span>{componentNames.get(selectedComponent) || selectedComponent}</span><button type="button" aria-label="清除组件选择" onClick={onClearComponent}><X size={12} /></button></div> : null}
        <textarea aria-label="主题修改指令" value={input} onChange={(event) => setInput(event.target.value)} placeholder={!connected ? "连接本地 Agent 后开始修改..." : theme.origin === "blank" ? "描述你想生成的主题..." : "告诉 Agent 想怎么修改..."} rows={3} disabled={!connected || locked} />
        <div className="composer-actions"><span className="model-button"><Command size={13} />DreamSkin Tool</span><button type="submit" className="send-button" disabled={!input.trim() || locked || !connected} aria-label="发送"><Send size={15} /></button></div>
      </form>
    </aside>
  );
}

function ThemeWorkspace({
  item,
  targetName,
  agent,
  connection,
  messages,
  onBack,
  onChange,
  onMessagesChange,
  onApplied,
  onError,
}: {
  item: LocalTheme;
  targetName: string;
  agent?: AgentDto;
  connection: AgentConnection;
  messages: ChatMessage[];
  onBack: () => void;
  onChange: (item: LocalTheme) => void;
  onMessagesChange: (update: (items: ChatMessage[]) => ChatMessage[]) => void;
  onApplied: (item: LocalTheme) => void;
  onError: (title: string, detail: string) => void;
}) {
  const [scene, setScene] = useState<ThemePreviewScene>("work");
  const [appearanceMode, setAppearanceMode] = useState<AppearanceMode>(item.theme.appearance.colorScheme === "dark" ? "dark" : "light");
  const [selectedComponent, setSelectedComponent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [history, setHistory] = useState<StudioTheme[]>([]);
  const [previewZoom, setPreviewZoom] = useState<(typeof previewZoomLevels)[number]>(1);
  const previewZoomIndex = previewZoomLevels.indexOf(previewZoom);

  const sendPrompt = async (prompt: string) => {
    if (busy || undoBusy || applyBusy || !agent || !connectionIsReady(connection)) return;
    onMessagesChange((items) => [...items, { id: Date.now(), role: "user", text: prompt }]);
    setBusy(true);
    try {
      const result = await studioApi.sendThemeMessage(item.localId, {
        prompt,
        componentId: selectedComponent || undefined,
        agentId: agent.id,
        expectedRevision: item.revisionHash,
      });
      setHistory((items) => [...items.slice(-19), structuredClone(item.theme)]);
      setAppearanceMode(result.theme.theme.appearance.colorScheme === "dark" ? "dark" : "light");
      onChange(result.theme);
      onMessagesChange((items) => [...items, {
        id: Date.now() + 1,
        role: "assistant",
        text: result.message,
        changes: result.changes,
      }]);
    } catch (error) {
      onError("主题修改失败", errorMessage(error));
      if (error instanceof ApiError && error.code === "REVISION_CONFLICT") {
        studioApi.getTheme(item.localId).then(onChange).catch(() => {});
      }
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    const previous = history.at(-1);
    if (!previous || undoBusy || busy || applyBusy) return;
    setUndoBusy(true);
    try {
      const updated = await studioApi.updateTheme(item.localId, structuredClone(previous), item.revisionHash);
      setHistory((items) => items.slice(0, -1));
      setAppearanceMode(updated.theme.appearance.colorScheme === "dark" ? "dark" : "light");
      onChange(updated);
    } catch (error) {
      onError("撤销失败", errorMessage(error));
      if (error instanceof ApiError && error.code === "REVISION_CONFLICT") {
        studioApi.getTheme(item.localId).then(onChange).catch(() => {});
      }
    } finally {
      setUndoBusy(false);
    }
  };

  const apply = async () => {
    if (applyBusy || busy || undoBusy) return;
    setApplyBusy(true);
    try {
      const result = await studioApi.applyTheme(item.localId);
      onChange(result.theme);
      onApplied(result.theme);
    } catch (error) {
      onError("应用主题失败", errorMessage(error));
    } finally {
      setApplyBusy(false);
    }
  };

  return (
    <main className="theme-workspace">
      <header className="editor-toolbar">
        <div className="editor-title"><IconButton label="返回我的主题" onClick={onBack}><ArrowLeft size={16} /></IconButton><div><strong>{item.theme.name}</strong><span><i />已保存 · v{item.revision}</span></div></div>
        <div className="scene-tabs" role="group" aria-label="预览界面">{sceneOptions.map((option) => <button type="button" key={option.value} aria-label={option.label} aria-pressed={scene === option.value} className={scene === option.value ? "is-active" : ""} onClick={() => setScene(option.value)}>{option.icon}<span>{option.label}</span></button>)}</div>
        <div className="editor-actions"><IconButton label="撤销" disabled={!history.length || undoBusy || busy || applyBusy} onClick={undo}>{undoBusy ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}</IconButton><button className="primary-button" type="button" onClick={apply} disabled={applyBusy || busy || undoBusy}>{applyBusy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{applyBusy ? "应用中" : `应用到 ${targetName}`}</button></div>
      </header>
      <div className="editor-body">
        <ChatPane theme={item} agent={agent} connection={connection} messages={messages} selectedComponent={selectedComponent} busy={busy} locked={busy || undoBusy || applyBusy} onSend={sendPrompt} onClearComponent={() => setSelectedComponent(null)} />
        <section className="preview-pane">
          <header className="preview-toolbar"><div><span className="live-indicator"><i />实时预览</span><span>{sceneOptions.find((option) => option.value === scene)?.label}</span></div><div><Segmented value={appearanceMode} onChange={setAppearanceMode} label="预览外观" options={[{ value: "light", label: "浅色" }, { value: "dark", label: "深色" }]} /><div className="preview-zoom-controls" role="group" aria-label="预览缩放"><IconButton className="zoom-button" label="缩小预览" disabled={previewZoomIndex <= 0} onClick={() => setPreviewZoom(previewZoomLevels[Math.max(0, previewZoomIndex - 1)])}><ZoomOut size={14} /></IconButton><span aria-live="polite">{Math.round(previewZoom * 100)}%</span><IconButton className="zoom-button" label="放大预览" disabled={previewZoomIndex >= previewZoomLevels.length - 1} onClick={() => setPreviewZoom(previewZoomLevels[Math.min(previewZoomLevels.length - 1, previewZoomIndex + 1)])}><ZoomIn size={14} /></IconButton><IconButton className="zoom-button" label="适合窗口" disabled={previewZoom === 1} onClick={() => setPreviewZoom(1)}><Maximize2 size={13} /></IconButton></div></div></header>
          <div className="preview-canvas"><div className="preview-surface"><Suspense fallback={<div className="preview-loading" role="status" aria-label="正在载入主题预览"><LoaderCircle className="spin" size={18} /></div>}><ThemeScenePreview theme={item.theme} appearanceMode={appearanceMode} scene={scene} zoom={previewZoom} interactive onComponentSelect={(id) => id && setSelectedComponent(id)} /></Suspense></div></div>
          <footer className="preview-status"><span><Monitor size={13} />{targetName} Desktop</span><span>{selectedComponent ? `已选择：${componentNames.get(selectedComponent) || selectedComponent}` : "点击组件，或用 Tab 聚焦后按 Enter 选择"}</span><span><Check size={13} />结构有效</span></footer>
        </section>
      </div>
    </main>
  );
}

function ThemeDetail({ entry, local, motionDisabled, onClose, onAdd, onOpen }: { entry: CatalogEntry; local?: LocalTheme; motionDisabled: boolean; onClose: () => void; onAdd: () => void; onOpen: () => void }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') || [])];
      if (!focusable.length) return;
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? current <= 0 ? focusable.length - 1 : current - 1
        : current === -1 || current >= focusable.length - 1 ? 0 : current + 1;
      event.preventDefault();
      focusable[next]?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <motion.div className="modal-backdrop" initial={motionDisabled ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={motionDisabled ? undefined : { opacity: 0 }} transition={motionDisabled ? { duration: 0 } : undefined} onMouseDown={onClose}>
      <motion.section ref={dialogRef} className="theme-detail" role="dialog" aria-modal="true" aria-labelledby={titleId} initial={motionDisabled ? false : { opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={motionDisabled ? undefined : { opacity: 0, y: 8, scale: 0.99 }} transition={motionDisabled ? { duration: 0 } : { type: "spring", bounce: 0, duration: 0.34 }} onMouseDown={(event) => event.stopPropagation()}>
        <button ref={closeRef} className="modal-close" type="button" onClick={onClose} aria-label="关闭"><X size={17} /></button>
        <div className="detail-art"><ThemeArtwork theme={entry.theme} /></div>
        <div className="detail-content"><span className="detail-target"><Command size={13} />{entry.target || targetNameFromId(entry.targetId)} Theme</span><h2 id={titleId}>{entry.theme.name}</h2><p>{entry.theme.description}</p><div className="detail-author"><span className="author-avatar">{entry.author.trim().charAt(0).toUpperCase() || "D"}</span><div><strong>{entry.author}</strong><span>版本 {entry.version} · {entry.downloads} 次添加</span></div></div><div className="detail-tags">{entry.categories.map((category) => <span key={category}>{category}</span>)}</div><div className="coverage-list"><strong>包含界面</strong><div><span><Check size={13} />Work</span><span><Check size={13} />Code</span><span><Check size={13} />Design</span><span><Check size={13} />对话页</span><span><Check size={13} />{componentRegistry.components.length} 个组件</span></div></div><button className="detail-primary" type="button" onClick={local ? onOpen : onAdd}>{local ? <Eye size={16} /> : <CloudDownload size={16} />}{local ? "打开我的主题" : "添加到我的主题"}</button></div>
      </motion.section>
    </motion.div>
  );
}

export default function App() {
  const desktopShell = typeof window !== "undefined" && Boolean(window.dreamskin);
  const prefersReducedMotion = useReducedMotion();
  const [view, setView] = useState<View>("center");
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [localThemes, setLocalThemes] = useState<LocalTheme[]>([]);
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [connection, setConnection] = useState<AgentConnection>(disconnectedConnection);
  const [settings, setSettings] = useState<StudioSettings>(defaultSettings);
  const [inspect, setInspect] = useState<InspectDto | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatusDto | null>(null);
  const [plugins, setPlugins] = useState<PluginDto[]>([]);
  const [activePluginId, setActivePluginId] = useState("");
  const [messagesByTheme, setMessagesByTheme] = useState<Record<string, ChatMessage[]>>({});
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [detailEntry, setDetailEntry] = useState<CatalogEntry | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [bootstrapError, setBootstrapError] = useState("");
  const addingTemplatesRef = useRef(new Set<string>());
  const creatingThemeRef = useRef(false);
  const toastSequenceRef = useRef(0);
  const themeRefreshSequenceRef = useRef(0);
  const workspaceTheme = localThemes.find((item) => item.localId === workspaceId);
  const connectedAgent = agents.find((agent) => agent.id === connection.agentId);
  const activePlugin = plugins.find((plugin) => plugin.id === activePluginId) || plugins.find((plugin) => plugin.active);
  const activeTargetName = activePlugin?.manifest.target.name || catalog[0]?.target || "目标应用";
  const targetNameForTheme = (item: LocalTheme) => (
    plugins.find((plugin) => plugin.id === item.pluginId)?.manifest.target.name
    || catalog.find((entry) => entry.pluginId === item.pluginId)?.target
    || catalog.find((entry) => entry.targetId === item.targetId)?.target
    || targetNameFromId(item.targetId)
  );

  const motionDisabled = !settings.motionEnabled || Boolean(prefersReducedMotion);

  const toast = (title: string, detail: string, tone: ToastTone = "success") => {
    const id = ++toastSequenceRef.current;
    setToasts((items) => [...items, { id, title, detail, tone }]);
    const timeout = tone === "error" ? 9000 : tone === "info" ? 5200 : 4000;
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), timeout);
  };

  useEffect(() => {
    let active = true;
    studioApi.bootstrap()
      .then((data) => {
        if (!active) return;
        setBootstrapError("");
        setCatalog(data.catalog);
        setLocalThemes(data.themes);
        setAgents(data.agents);
        setConnection(data.connection);
        setSettings(data.settings);
        setInspect(data.inspect);
        setRuntime(data.runtime);
        setPlugins(data.plugins || []);
        setActivePluginId(data.activePluginId || "");
      })
      .catch((error) => {
        if (active) {
          const detail = errorMessage(error);
          setBootstrapError(detail);
          toast("Studio 后端未就绪", detail, "error");
        }
      })
      .finally(() => {
        if (active) setBootstrapping(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (bootstrapping || bootstrapError || !["center", "library", "workspace"].includes(view)) return;
    const sequence = ++themeRefreshSequenceRef.current;
    let active = true;
    studioApi.listThemes()
      .then((themes) => {
        if (!active || sequence !== themeRefreshSequenceRef.current) return;
        setLocalThemes(themes);
        if (view === "workspace" && workspaceId && !themes.some((item) => item.localId === workspaceId)) {
          setWorkspaceId(null);
          setView("library");
          toast("主题已在其他位置移除", "主题列表已重新同步，工作区已返回我的主题。", "error");
        }
      })
      .catch((error) => {
        if (active && sequence === themeRefreshSequenceRef.current) {
          toast("同步主题失败", errorMessage(error), "error");
        }
      });
    return () => {
      active = false;
    };
  }, [bootstrapError, bootstrapping, view, workspaceId]);

  const openWorkspace = (id: string) => {
    setWorkspaceId(id);
    setView("workspace");
    setDetailEntry(null);
  };

  const addTemplate = async (entry: CatalogEntry) => {
    const templateKey = `${entry.pluginId}:${entry.theme.id}`;
    const existing = localThemes.find((item) => item.pluginId === entry.pluginId && item.sourceId === entry.theme.id);
    if (existing) {
      openWorkspace(existing.localId);
      return;
    }
    if (addingTemplatesRef.current.has(templateKey)) return;
    addingTemplatesRef.current.add(templateKey);
    try {
      const local = await studioApi.createTheme({ kind: "template", sourceId: entry.theme.id });
      themeRefreshSequenceRef.current += 1;
      setLocalThemes((items) => putTheme(items, local));
      setDetailEntry(null);
      toast("已添加到我的主题", `${local.theme.name} 可以开始编辑了。`);
    } catch (error) {
      toast("添加主题失败", errorMessage(error), "error");
    } finally {
      addingTemplatesRef.current.delete(templateKey);
    }
  };

  const createBlank = async () => {
    if (bootstrapping || bootstrapError || creatingThemeRef.current) return;
    creatingThemeRef.current = true;
    try {
      const local = await studioApi.createTheme({ kind: "blank" });
      themeRefreshSequenceRef.current += 1;
      setLocalThemes((items) => putTheme(items, local));
      setWorkspaceId(local.localId);
      setView("workspace");
      toast("空白主题已创建", "现在可以和 Agent 对话生成主题。" );
    } catch (error) {
      toast("创建主题失败", errorMessage(error), "error");
    } finally {
      creatingThemeRef.current = false;
    }
  };

  const duplicateTheme = async (item: LocalTheme) => {
    try {
      const duplicate = await studioApi.duplicateTheme(item.localId);
      themeRefreshSequenceRef.current += 1;
      setLocalThemes((items) => putTheme(items, duplicate));
      toast("主题已复制", `${duplicate.theme.name} 已添加到我的主题。`);
      return true;
    } catch (error) {
      toast("复制主题失败", errorMessage(error), "error");
      return false;
    }
  };

  const deleteTheme = async (item: LocalTheme) => {
    try {
      await studioApi.deleteTheme(item.localId, { expectedRevision: item.revisionHash });
      themeRefreshSequenceRef.current += 1;
      setLocalThemes((items) => items.filter((candidate) => candidate.localId !== item.localId));
      setMessagesByTheme((current) => {
        const next = { ...current };
        delete next[item.localId];
        return next;
      });
      if (workspaceId === item.localId) {
        setWorkspaceId(null);
        setView("library");
      }
      toast("主题已删除", `${item.theme.name} 已从我的主题移除。`);
      return true;
    } catch (error) {
      toast("删除主题失败", errorMessage(error), "error");
      return false;
    }
  };

  const updateLocalTheme = (updated: LocalTheme) => {
    themeRefreshSequenceRef.current += 1;
    setLocalThemes((items) => {
      const normalized = updated.status === "applied"
        ? items.map((item) => item.localId !== updated.localId && item.status === "applied" ? { ...item, status: "verified" as const } : item)
        : items;
      return putTheme(normalized, updated);
    });
  };

  const refreshAgents = async () => {
    try {
      const refreshed = await studioApi.listAgents();
      const connected = refreshed.find((agent) => agent.state === "connected");
      setAgents(refreshed);
      setConnection(connected
        ? { agentId: connected.id, state: "connected" }
        : disconnectedConnection);
      toast("扫描完成", "本机 Agent 列表已更新。");
    } catch (error) {
      toast("扫描 Agent 失败", errorMessage(error), "error");
    }
  };

  const connectAgent = async (id: string) => {
    try {
      const result = await studioApi.connectAgent(id);
      setAgents(result.agents);
      setConnection(result.connection);
      const agent = result.agents.find((item) => item.id === result.connection.agentId);
      if (agent && connectionIsReady(result.connection)) toast("Agent 已连接", `${agent.name} 已通过 ACP 就绪。`);
      else toast("Agent 未连接", "后端没有建立可用的 ACP 连接。", "info");
    } catch (error) {
      toast("连接 Agent 失败", errorMessage(error), "error");
    }
  };

  const updateSettings = async (patch: Partial<Pick<StudioSettings, "autoVerify" | "motionEnabled">>) => {
    try {
      const updated = await studioApi.updateSettings(patch);
      setSettings(updated);
    } catch (error) {
      toast("保存设置失败", errorMessage(error), "error");
    }
  };

  const verifyRuntime = async () => {
    try {
      const result = await studioApi.verifyRuntime();
      const themeName = localThemes.find((item) => item.localId === runtime?.themeId)?.theme.name;
      toast("运行验证通过", themeName ? `${themeName} 的实际换肤结果正常。` : `${activeTargetName} 主题运行正常。`);
      const themeId = result.themeId;
      if (typeof themeId === "string") {
        setRuntime((current) => ({ ...(current || {}), available: true, session: "active", themeId }));
      }
    } catch (error) {
      toast("运行验证失败", errorMessage(error), "error");
    }
  };

  const restoreRuntime = async () => {
    try {
      const result = await studioApi.restoreRuntime();
      setRuntime(result.after || { available: true, session: "inactive" });
      setLocalThemes((items) => items.map((item) => (
        item.status === "applied" ? { ...item, status: "verified" as const } : item
      )));
      toast("已恢复原生界面", `${activeTargetName} 已停止使用 DreamSkin 主题。`);
    } catch (error) {
      toast("恢复原生界面失败", errorMessage(error), "error");
    }
  };

  const navigate = (target: View) => {
    if (target === "workspace" && !workspaceTheme) return;
    setView(target);
  };

  const updateThemeMessages = (theme: LocalTheme, update: (items: ChatMessage[]) => ChatMessage[]) => {
    setMessagesByTheme((current) => ({
      ...current,
      [theme.localId]: update(current[theme.localId] || initialThemeMessages(theme)),
    }));
  };

  const detailLocal = detailEntry ? localThemes.find((item) => (
    item.pluginId === detailEntry.pluginId && item.sourceId === detailEntry.theme.id
  )) : undefined;

  return (
    <MotionConfig reducedMotion={motionDisabled ? "always" : "never"}>
    <div className={`studio-app ${desktopShell ? "is-desktop-shell" : ""} ${motionDisabled ? "reduce-motion" : ""}`}>
      <WindowBar view={view} workspaceTheme={workspaceTheme} agent={connectedAgent} connection={connection} onNavigate={navigate} onCreateTheme={createBlank} createDisabled={bootstrapping || Boolean(bootstrapError)} />
      <AppRail view={view} agent={connectedAgent} connection={connection} onNavigate={navigate} />
      <div className="app-content">
        {bootstrapping ? <div className="bootstrap-loading" role="status"><LoaderCircle className="spin" size={19} /><strong>正在载入 Studio</strong></div> : null}
        {!bootstrapping && bootstrapError ? <div className="bootstrap-error" role="alert"><Info size={19} /><strong>无法载入 Studio</strong><span>{bootstrapError}</span><button type="button" onClick={() => window.location.reload()}><RotateCcw size={13} />重试</button></div> : null}
        {!bootstrapping && !bootstrapError && view === "center" ? <ThemeCenter catalog={catalog} localThemes={localThemes} targetNameForTheme={targetNameForTheme} onAdd={addTemplate} onOpen={openWorkspace} onDuplicate={duplicateTheme} onDelete={deleteTheme} onCreateBlank={createBlank} onInspect={setDetailEntry} onLibrary={() => setView("library")} /> : null}
        {!bootstrapping && !bootstrapError && view === "library" ? <MyThemes localThemes={localThemes} targetNameForTheme={targetNameForTheme} onCreateBlank={createBlank} onOpen={openWorkspace} onDuplicate={duplicateTheme} onDelete={deleteTheme} /> : null}
        {!bootstrapping && !bootstrapError && view === "connections" ? <Connections agents={agents} connection={connection} onConnect={connectAgent} onRefresh={refreshAgents} /> : null}
        {!bootstrapping && !bootstrapError && view === "settings" ? <SettingsView settings={settings} inspect={inspect} runtime={runtime} targetName={activeTargetName} onChange={updateSettings} onVerifyRuntime={verifyRuntime} onRestoreRuntime={restoreRuntime} /> : null}
        {!bootstrapping && !bootstrapError && view === "workspace" && workspaceTheme ? <ThemeWorkspace key={workspaceTheme.localId} item={workspaceTheme} targetName={targetNameForTheme(workspaceTheme)} agent={connectedAgent} connection={connection} messages={messagesByTheme[workspaceTheme.localId] || initialThemeMessages(workspaceTheme)} onBack={() => setView("library")} onChange={updateLocalTheme} onMessagesChange={(update) => updateThemeMessages(workspaceTheme, update)} onApplied={(item) => { setRuntime((current) => ({ ...(current || {}), available: true, session: "active", themeId: item.localId })); toast("主题已应用", `${item.theme.name} 已通过 DreamSkin Tool 应用到 ${targetNameForTheme(item)}。`); }} onError={(title, detail) => toast(title, detail, "error")} /> : null}
      </div>

      <AnimatePresence>
        {detailEntry ? <ThemeDetail entry={detailEntry} local={detailLocal} motionDisabled={motionDisabled} onClose={() => setDetailEntry(null)} onAdd={() => addTemplate(detailEntry)} onOpen={() => detailLocal && openWorkspace(detailLocal.localId)} /> : null}
      </AnimatePresence>

      <div className="toast-region">
        <AnimatePresence>
          {toasts.map((item) => <motion.div className={`toast is-${item.tone}`} role={item.tone === "error" ? "alert" : "status"} aria-atomic="true" key={item.id} initial={motionDisabled ? false : { opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={motionDisabled ? undefined : { opacity: 0, y: 8 }} transition={motionDisabled ? { duration: 0 } : undefined}><span>{item.tone === "error" ? <CircleAlert size={15} /> : item.tone === "info" ? <Info size={15} /> : <Check size={15} />}</span><div><strong>{item.title}</strong><small>{item.detail}</small></div><button type="button" aria-label="关闭通知" onClick={() => setToasts((items) => items.filter((toastItem) => toastItem.id !== item.id))}><X size={13} /></button></motion.div>)}
        </AnimatePresence>
      </div>
    </div>
    </MotionConfig>
  );
}
