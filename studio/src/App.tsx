import {
  AppWindow,
  ArrowDownAZ,
  ArrowLeft,
  BookOpen,
  BriefcaseBusiness,
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
  Plus,
  RotateCcw,
  Search,
  Settings,
  SwatchBook,
  Terminal,
  Trash2,
  WandSparkles,
  Workflow,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "motion/react";
import {
  type CSSProperties,
  type ReactNode,
  Suspense,
  lazy,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import componentRegistry from "../../plugins/trae/resources/components.v1.json";
import workBuddySceneRegistry from "../../plugins/workbuddy/resources/studio-scenes.v1.json";

import {
  type CatalogEntry,
  type LocalTheme,
  type ThemeCategory,
} from "./catalog";
import {
  type CliStatusDto,
  type InspectDto,
  type PluginDto,
  type RuntimeStatusDto,
  type SoftwareUpdateState,
  type StudioTargetDto,
  type StudioSettings,
  studioApi,
} from "./api";
import type { ThemePreviewScene } from "./ThemeShowcase";
import { type AppearanceMode, type StudioTheme } from "./themes";

const ThemeScenePreview = lazy(() => import("./ThemeShowcase").then((module) => ({
  default: module.ThemeScenePreview,
})));

type View = "center" | "library" | "settings" | "workspace";
type ThemeSort = "recent" | "name";
type LibrarySyncState = "idle" | "syncing" | "synced" | "error";
type ToastTone = "success" | "error" | "info";
type Toast = { id: number; title: string; detail: string; tone: ToastTone };
type TargetOption = { pluginId: string; targetId: string; name: string };

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

const traeSceneOptions: Array<{ value: ThemePreviewScene; label: string; icon: ReactNode }> = [
  { value: "work", label: "Work", icon: <BookOpen size={14} /> },
  { value: "code", label: "Code", icon: <Code2 size={14} /> },
  { value: "design", label: "Design", icon: <Palette size={14} /> },
  { value: "thread", label: "对话页", icon: <MessageSquareText size={14} /> },
  { value: "components", label: "组件", icon: <Boxes size={14} /> },
];

const workBuddySceneIcons: Record<string, ReactNode> = {
  home: <Home size={14} />,
  chat: <MessageSquareText size={14} />,
  result: <AppWindow size={14} />,
  market: <BookOpen size={14} />,
  automation: <Workflow size={14} />,
  project: <FolderHeart size={14} />,
  settings: <Settings size={14} />,
  overlays: <Boxes size={14} />,
};

const workBuddySceneOptions: Array<{ value: ThemePreviewScene; label: string; icon: ReactNode }> = [
  ...workBuddySceneRegistry.scenes.map((scene) => ({
    value: `wb-${scene.id}` as ThemePreviewScene,
    label: scene.name,
    icon: workBuddySceneIcons[scene.id] || <AppWindow size={14} />,
  })),
  { value: "wb-components", label: "组件", icon: <Boxes size={14} /> },
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

const workBuddyComponentLabels: Record<string, string> = {
  "shell.workspace": "工作台外壳",
  "shell.titlebar": "窗口标题栏",
  "sidebar.navigation": "侧栏导航",
  "sidebar.project": "项目列表",
  "home.hero": "首页主视觉",
  "home.quickAction": "快捷操作",
  "chat.timeline": "对话时间线",
  "chat.message.user": "用户消息",
  "chat.message.agent": "Agent 消息",
  "chat.toolCall": "工具调用",
  "composer.surface": "任务输入区",
  "composer.tool": "输入区工具",
  "action.primary": "主要操作",
  "result.shell": "结果工作区",
  "result.tabs": "结果标签",
  "result.artifact": "结果产物",
  "result.fileTree": "文件列表",
  "market.toolbar": "资源筛选",
  "market.card": "资源卡片",
  "automation.task": "自动化任务",
  "automation.run": "运行记录",
  "project.card": "项目卡片",
  "settings.section": "设置面板",
  "input.field": "输入框",
  "selection.control": "选择控件",
  "overlay.menu": "菜单",
  "overlay.dialog": "对话框",
  "overlay.tooltip": "提示",
  "status.badge": "状态标记",
  "status.toast": "通知",
  "loading.skeleton": "加载状态",
  "empty.state": "空状态",
};

const traeComponentNames = new Map(
  componentRegistry.components.map((component) => [component.id, componentLabels[component.id] || component.id] as const),
);
const workBuddyComponentNames = new Map(Object.entries(workBuddyComponentLabels));

const WORKBUDDY_PLUGIN_ID = "dreamskin.workbuddy";

function isWorkBuddyTarget(value: { pluginId?: string; targetId?: string }) {
  return value.pluginId === WORKBUDDY_PLUGIN_ID || value.targetId?.toLowerCase() === "workbuddy";
}

function sceneOptionsForTheme(item: LocalTheme) {
  return isWorkBuddyTarget(item) ? workBuddySceneOptions : traeSceneOptions;
}

function componentNameForTheme(item: LocalTheme, componentId: string) {
  const names = isWorkBuddyTarget(item) ? workBuddyComponentNames : traeComponentNames;
  return names.get(componentId) || componentId;
}

function coverageForTarget(entry: CatalogEntry) {
  return isWorkBuddyTarget(entry)
    ? [...workBuddySceneRegistry.scenes.map((scene) => scene.name), `${Object.keys(workBuddyComponentLabels).length} 个组件`]
    : ["Work", "Code", "Design", "对话页", `${componentRegistry.components.length} 个组件`];
}

function themeIdentity(item: Pick<LocalTheme, "pluginId" | "localId">) {
  return `${item.pluginId}::${item.localId}`;
}

function distinctThemes(items: LocalTheme[]) {
  return [...new Map(items.map((item) => [themeIdentity(item), item])).values()];
}

function distinctCatalog(items: CatalogEntry[]) {
  return [...new Map(items.map((item) => [`${item.pluginId}::${item.theme.id}`, item])).values()];
}

const defaultSettings: StudioSettings = {
  themesRoot: "",
  motionEnabled: true,
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "发生了未知错误。";
}

function putTheme(items: LocalTheme[], updated: LocalTheme) {
  const index = items.findIndex((item) => themeIdentity(item) === themeIdentity(updated));
  if (index === -1) return [updated, ...items];
  return items.map((item) => themeIdentity(item) === themeIdentity(updated) ? updated : item);
}

function targetNameFromId(targetId: string) {
  if (!targetId) return "目标应用";
  return targetId.charAt(0).toUpperCase() + targetId.slice(1);
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

function AppRail({ view, onNavigate }: { view: View; onNavigate: (view: View) => void }) {
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
      <button className="brand-mark" type="button" aria-label="DreamSkin Studio" onClick={() => onNavigate("library")}>
        <SwatchBook size={21} />
      </button>
      <div className="rail-actions">
        {item("library", "我的主题", <FolderHeart size={19} />)}
        {item("center", "模板库", <LayoutGrid size={19} />)}
      </div>
      <div className="rail-spacer" />
      {item("settings", "设置", <Settings size={19} />)}
    </nav>
  );
}

function WindowBar({
  view,
  workspaceTheme,
  syncState,
  onNavigate,
  onCreateTheme,
  createDisabled,
}: {
  view: View;
  workspaceTheme?: LocalTheme;
  syncState: LibrarySyncState;
  onNavigate: (view: View) => void;
  onCreateTheme: () => void;
  createDisabled: boolean;
}) {
  return (
    <header className="window-bar">
      <div className="traffic-lights" aria-hidden="true"><i /><i /><i /></div>
      <div className="workspace-tabs" role="group" aria-label="工作区标签">
        <button type="button" className={view === "library" ? "is-active" : ""} aria-pressed={view === "library"} onClick={() => onNavigate("library")}>
          <FolderHeart size={13} /><span>我的主题</span>
        </button>
        <button type="button" className={view === "center" ? "is-active" : ""} aria-pressed={view === "center"} onClick={() => onNavigate("center")}>
          <LayoutGrid size={13} /><span>模板库</span>
        </button>
        {workspaceTheme ? (
          <button type="button" className={view === "workspace" ? "is-active" : ""} aria-pressed={view === "workspace"} onClick={() => onNavigate("workspace")}>
            <FolderHeart size={13} /><span>{workspaceTheme.theme.name}</span>
          </button>
        ) : null}
        <button type="button" className="tab-add tooltip" aria-label="新建空白主题" data-tooltip="新建空白主题" disabled={createDisabled} onClick={() => onCreateTheme()}><Plus size={14} /></button>
      </div>
      <div className="window-actions">
        <span className={`library-sync-pill is-${syncState}`}><RotateCcw className={syncState === "syncing" ? "spin" : ""} size={13} /><strong>{syncState === "error" ? "同步异常" : syncState === "syncing" ? "正在同步" : "本地主题库"}</strong></span>
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
        <span className="target-badge">{isWorkBuddyTarget(entry) ? <BriefcaseBusiness size={11} /> : <Command size={11} />}{entry.target || targetNameFromId(entry.targetId)}</span>
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
        <span>{isWorkBuddyTarget(entry) ? <BriefcaseBusiness size={12} /> : <Command size={12} />}{entry.target || targetNameFromId(entry.targetId)} 精选</span>
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

function BlankThemeCard({ onCreate, wide = false, targetName }: { onCreate: () => void; wide?: boolean; targetName?: string }) {
  return (
    <button className={`blank-theme-card ${wide ? "is-wide" : ""}`} type="button" onClick={onCreate}>
      <span className="blank-grid"><CirclePlus size={27} /></span>
      <span><strong>新建空白主题</strong><small>{targetName ? `为 ${targetName} 创建本地主题` : "选择目标应用后创建"}</small></span>
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
  targets,
  onAdd,
  onOpen,
  onInspect,
}: {
  catalog: CatalogEntry[];
  localThemes: LocalTheme[];
  targets: TargetOption[];
  onAdd: (entry: CatalogEntry) => void;
  onOpen: (theme: LocalTheme) => void;
  onInspect: (entry: CatalogEntry) => void;
}) {
  const [category, setCategory] = useState<"全部" | ThemeCategory>("全部");
  const [query, setQuery] = useState("");
  const [targetPluginId, setTargetPluginId] = useState("all");
  const targetSummary = targets.map((target) => target.name).join(" · ") || "暂无目标";
  const normalizedQuery = query.trim().toLowerCase();
  const localFor = (entry: CatalogEntry) => localThemes.find((item) => (
    item.pluginId === entry.pluginId && item.sourceId === entry.theme.id
  ));
  const featuredEntries = catalog.filter((entry) => (
    entry.featured && (targetPluginId === "all" || entry.pluginId === targetPluginId)
  )).slice(0, 2);
  const filtered = catalog.filter((entry) => {
    const matchesTarget = targetPluginId === "all" || entry.pluginId === targetPluginId;
    const matchesCategory = category === "全部" || entry.categories.includes(category);
    const matchesQuery = `${entry.theme.name} ${entry.theme.description} ${entry.author} ${entry.categories.join(" ")}`.toLowerCase().includes(normalizedQuery);
    return matchesTarget && matchesCategory && matchesQuery;
  });

  return (
    <main className="page-scroll">
      <div className="content-width">
        <PageHeading
          title="模板库"
          meta={`${targetSummary} · ${catalog.length} 个可用主题`}
          action={<label className="global-search"><Search size={16} /><input aria-label="搜索主题" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索主题" />{query ? <button type="button" aria-label="清除搜索" onClick={() => setQuery("")}><X size={14} /></button> : null}</label>}
        />

        <div className="catalog-toolbar">
          <div className="target-tabs" role="group" aria-label="目标应用"><span>目标</span>{targets.length > 1 ? <button type="button" className={targetPluginId === "all" ? "is-active" : ""} aria-pressed={targetPluginId === "all"} onClick={() => setTargetPluginId("all")}>全部</button> : null}{targets.map((target) => <button type="button" className={targetPluginId === target.pluginId || targets.length === 1 ? "is-active" : ""} aria-pressed={targetPluginId === target.pluginId || targets.length === 1} key={target.pluginId} onClick={() => setTargetPluginId(target.pluginId)}>{isWorkBuddyTarget(target) ? <BriefcaseBusiness size={13} /> : <Command size={13} />}{target.name}</button>)}</div>
        </div>
        <div className="category-strip" role="group" aria-label="主题分类">
          {categories.map((item) => <button type="button" key={item} className={item === category ? "is-active" : ""} aria-pressed={item === category} onClick={() => setCategory(item)}>{item}</button>)}
        </div>

        {!query && category === "全部" && featuredEntries.length ? (
          <section className="content-section">
            <div className="section-heading"><div><strong>本周精选</strong><span>由 DreamSkin 编辑推荐</span></div><span className="section-count">{String(featuredEntries.length).padStart(2, "0")}</span></div>
            <div className="featured-grid">
              {featuredEntries.map((entry) => {
                const local = localFor(entry);
                return <FeaturedCard key={`${entry.pluginId}:${entry.theme.id}`} entry={entry} local={local} onAdd={() => onAdd(entry)} onOpen={() => local && onOpen(local)} />;
              })}
            </div>
          </section>
        ) : null}

        <section className="content-section">
          <div className="section-heading"><div><strong>{category === "全部" ? "全部模板" : category}</strong><span>{filtered.length} 个主题</span></div></div>
          <div className="template-grid">
            {filtered.map((entry) => {
              const local = localFor(entry);
              return <TemplateCard key={`${entry.pluginId}:${entry.theme.id}`} entry={entry} local={local} onAdd={() => onAdd(entry)} onOpen={() => local && onOpen(local)} onInspect={() => onInspect(entry)} />;
            })}
          </div>
          {!filtered.length ? <div className="catalog-empty"><Search size={18} /><strong>没有匹配的模板</strong><span>换个关键词、分类或目标试试。</span></div> : null}
        </section>
      </div>
    </main>
  );
}

function MyThemes({
  localThemes,
  targets,
  targetNameForTheme,
  onCreateBlank,
  onOpen,
  onDuplicate,
  onDelete,
}: {
  localThemes: LocalTheme[];
  targets: TargetOption[];
  targetNameForTheme: (theme: LocalTheme) => string;
  onCreateBlank: (pluginId?: string) => void;
  onOpen: (theme: LocalTheme) => void;
  onDuplicate: (theme: LocalTheme) => Promise<boolean>;
  onDelete: (theme: LocalTheme) => Promise<boolean>;
}) {
  const [targetPluginId, setTargetPluginId] = useState("all");
  const [sort, setSort] = useState<ThemeSort>("recent");
  useEffect(() => {
    if (targetPluginId !== "all" && !targets.some((target) => target.pluginId === targetPluginId)) setTargetPluginId("all");
  }, [targetPluginId, targets]);
  const selectedTarget = targets.find((target) => target.pluginId === targetPluginId) || (targets.length === 1 ? targets[0] : undefined);
  const filteredThemes = targetPluginId === "all" ? localThemes : localThemes.filter((item) => item.pluginId === targetPluginId);
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
        <PageHeading title="我的主题" meta={`${localThemes.length} 个本地主题`} action={<button className="primary-button" type="button" onClick={() => onCreateBlank(selectedTarget?.pluginId)}><CirclePlus size={16} />新建空白主题</button>} />
        <div className="library-filter-row"><div role="group" aria-label="目标应用筛选"><button type="button" className={targetPluginId === "all" ? "is-active" : ""} aria-pressed={targetPluginId === "all"} onClick={() => setTargetPluginId("all")}>全部</button>{targets.map((target) => <button type="button" className={targetPluginId === target.pluginId ? "is-active" : ""} aria-pressed={targetPluginId === target.pluginId} key={target.pluginId} onClick={() => setTargetPluginId(target.pluginId)}>{target.name}</button>)}</div><div className="library-sort" role="group" aria-label="主题排序"><button type="button" className={sort === "recent" ? "is-active" : ""} aria-pressed={sort === "recent"} onClick={() => setSort("recent")}><History size={13} />最近修改</button><button type="button" className={sort === "name" ? "is-active" : ""} aria-pressed={sort === "name"} onClick={() => setSort("name")}><ArrowDownAZ size={13} />名称</button></div></div>
        <div className="library-grid page-library-grid">
          <BlankThemeCard onCreate={() => onCreateBlank(selectedTarget?.pluginId)} wide targetName={selectedTarget?.name} />
          {visibleThemes.map((item) => <LocalThemeCard key={themeIdentity(item)} item={item} targetName={targetNameForTheme(item)} onOpen={() => onOpen(item)} onDuplicate={() => onDuplicate(item)} onDelete={() => onDelete(item)} />)}
        </div>
      </div>
    </main>
  );
}

function SettingsView({
  settings,
  cliStatus,
  cliBusy,
  inspect,
  runtime,
  targets,
  inspectByPlugin,
  runtimeByPlugin,
  defaultPluginId,
  onChange,
  onCliRefresh,
  onCliInstall,
  onCliUninstall,
  onVerifyRuntime,
  onRestoreRuntime,
}: {
  settings: StudioSettings;
  cliStatus: CliStatusDto | null;
  cliBusy: "refresh" | "install" | "uninstall" | null;
  inspect: InspectDto | null;
  runtime: RuntimeStatusDto | null;
  targets: TargetOption[];
  inspectByPlugin: Record<string, InspectDto>;
  runtimeByPlugin: Record<string, RuntimeStatusDto>;
  defaultPluginId: string;
  onChange: (patch: Partial<Pick<StudioSettings, "motionEnabled">>) => Promise<void>;
  onCliRefresh: () => Promise<void>;
  onCliInstall: () => Promise<void>;
  onCliUninstall: () => Promise<void>;
  onVerifyRuntime: (pluginId: string) => Promise<void>;
  onRestoreRuntime: (pluginId: string) => Promise<void>;
}) {
  const [motionEnabled, setMotionEnabled] = useState(settings.motionEnabled);
  const [targetPluginId, setTargetPluginId] = useState(defaultPluginId || targets[0]?.pluginId || "");
  const [busy, setBusy] = useState<"motionEnabled" | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState<"verify" | "restore" | null>(null);
  useEffect(() => {
    setMotionEnabled(settings.motionEnabled);
  }, [settings.motionEnabled]);
  useEffect(() => {
    if (!targets.some((target) => target.pluginId === targetPluginId)) {
      setTargetPluginId(defaultPluginId || targets[0]?.pluginId || "");
    }
  }, [defaultPluginId, targetPluginId, targets]);
  const update = async (key: "motionEnabled", value: boolean) => {
    setBusy(key);
    try {
      await onChange({ [key]: value });
    } finally {
      setBusy(null);
    }
  };
  const selectedTarget = targets.find((target) => target.pluginId === targetPluginId) || targets[0];
  const selectedInspect = (selectedTarget && inspectByPlugin[selectedTarget.pluginId]) || inspect;
  const selectedRuntime = (selectedTarget && runtimeByPlugin[selectedTarget.pluginId]) || runtime;
  const targetName = selectedTarget?.name || "目标应用";
  const runtimeSession = selectedRuntime?.session;
  const runtimeLabel = selectedRuntime?.available === false || runtimeSession === "unsupported"
    ? "不可用"
    : runtimeSession === "active"
      ? "已连接"
      : runtimeSession === "degraded"
        ? "需要修复"
        : runtimeSession === "orphaned" || runtimeSession === "orphaned-unverified"
          ? "待清理"
          : runtimeSession === "off" || runtimeSession === "inactive"
            ? "未启用"
            : runtimeSession
              ? "待连接"
              : "未知";
  const runtimeCanVerify = runtimeSession === "active";
  const runtimeCanRestore = runtimeSession === "active"
    || runtimeSession === "degraded"
    || runtimeSession === "orphaned"
    || runtimeSession === "orphaned-unverified";
  const cliState = cliStatus?.state || (cliStatus?.installed ? "ready" : "not-installed");
  const cliReady = cliState === "ready";
  const cliStateLabel = cliState === "ready"
    ? "已安装"
    : cliState === "stale"
      ? "需要更新"
      : cliState === "unavailable"
        ? "不可用"
        : cliState === "unsupported"
          ? "不支持"
          : "未安装";
  const cliTitle = cliState === "ready"
    ? "本地命令已就绪"
    : cliState === "stale"
      ? "本地命令需要更新"
      : cliState === "unavailable"
        ? "本地命令暂不可用"
        : "管理本地主题命令";
  const cliCanInstall = Boolean(cliStatus?.supported) && cliState !== "unavailable";
  const runRuntimeAction = async (action: "verify" | "restore") => {
    if (!selectedTarget) return;
    setRuntimeBusy(action);
    try {
      if (action === "verify") await onVerifyRuntime(selectedTarget.pluginId);
      else await onRestoreRuntime(selectedTarget.pluginId);
    } finally {
      setRuntimeBusy(null);
    }
  };
  return (
    <main className="page-scroll">
      <div className="content-width narrow-content">
        <PageHeading title="设置" meta="DreamSkin Studio" />
        {targets.length > 1 ? <div className="settings-target-tabs" role="group" aria-label="设置目标应用">{targets.map((target) => <button type="button" key={target.pluginId} className={target.pluginId === selectedTarget?.pluginId ? "is-active" : ""} aria-pressed={target.pluginId === selectedTarget?.pluginId} onClick={() => setTargetPluginId(target.pluginId)}>{isWorkBuddyTarget(target) ? <BriefcaseBusiness size={14} /> : <Command size={14} />}{target.name}</button>)}</div> : null}
        <section className="settings-section cli-management-section">
          <div className="settings-title"><strong>DreamSkin CLI</strong><span className={`cli-state-badge is-${cliState}`}>{cliStateLabel}</span></div>
          <div className="cli-management-panel">
            <span className="cli-management-icon"><Terminal size={19} /></span>
            <div className="cli-management-copy"><strong>{cliTitle}</strong><small>{cliStatus?.message || (cliReady ? "Studio 会自动同步 CLI 写入的主题修改" : "安装后可从终端管理同一套本地主题")}</small><code>{cliStatus?.command || "dreamskin"}</code></div>
            <div className="cli-management-actions"><IconButton label="刷新 CLI 状态" disabled={Boolean(cliBusy)} onClick={() => void onCliRefresh()}><RotateCcw className={cliBusy === "refresh" ? "spin" : ""} size={15} /></IconButton>{cliStatus?.installed ? <><button className="secondary-button" type="button" disabled={Boolean(cliBusy) || !cliCanInstall} onClick={() => void onCliInstall()}>{cliBusy === "install" ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}重新安装</button><button className="danger-button" type="button" disabled={Boolean(cliBusy) || !cliStatus.supported} onClick={() => void onCliUninstall()}>{cliBusy === "uninstall" ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}卸载</button></> : <button className="primary-button" type="button" disabled={Boolean(cliBusy) || !cliCanInstall} onClick={() => void onCliInstall()}>{cliBusy === "install" ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}安装 CLI</button>}</div>
          </div>
          {cliStatus?.path || cliStatus?.targetPath ? <div className="cli-paths">{cliStatus.path ? <span><strong>当前路径</strong><code>{cliStatus.path}</code></span> : null}{cliStatus.targetPath ? <span><strong>安装位置</strong><code>{cliStatus.targetPath}</code></span> : null}</div> : null}
        </section>
        <section className="settings-section">
          <div className="settings-title"><strong>主题工作台</strong></div>
          <div className="setting-row"><span><strong>界面动效</strong><small>主题卡片与工作台过渡</small></span><button type="button" className={`toggle ${motionEnabled ? "is-on" : ""}`} role="switch" disabled={Boolean(busy)} aria-label="界面动效" aria-checked={motionEnabled} onClick={() => update("motionEnabled", !motionEnabled)}><i /></button></div>
          <div className="setting-row"><span><strong>主题存储位置</strong><small>{(selectedTarget && settings.themeRoots?.[selectedTarget.pluginId]) || settings.themesRoot || "未配置"}</small></span></div>
        </section>
        <section className="settings-section"><div className="settings-title"><strong>{targetName} 运行状态</strong></div><div className="diagnostic-row"><span><i />{targetName} Runtime</span><strong>{runtimeLabel}</strong></div><div className="diagnostic-row"><span><i />组件注册表</span><strong>{selectedInspect?.registry?.components?.length ?? (isWorkBuddyTarget(selectedTarget || {}) ? Object.keys(workBuddyComponentLabels).length : componentRegistry.components.length)} 项</strong></div><button type="button" className="setting-row command-row" disabled={!runtimeCanVerify || Boolean(runtimeBusy)} onClick={() => runRuntimeAction("verify")}><span><strong>验证当前主题</strong><small>检查 {targetName} 中的实际换肤结果</small></span>{runtimeBusy === "verify" ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}</button><button type="button" className="setting-row command-row" disabled={!runtimeCanRestore || Boolean(runtimeBusy)} onClick={() => runRuntimeAction("restore")}><span><strong>恢复原生界面</strong><small>停止当前主题并恢复 {targetName}</small></span>{runtimeBusy === "restore" ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}</button></section>
        <SoftwareUpdateSection />
      </div>
    </main>
  );
}

const browserUpdateState: SoftwareUpdateState = {
  enabled: false,
  reason: "browser",
  phase: "disabled",
  currentVersion: "",
  prerelease: false,
  update: null,
  progress: null,
  error: null,
  canCheck: false,
  canDownload: false,
  canInstall: false,
};

function updateDisabledLabel(reason: string | null) {
  if (reason === "development") return "开发构建不会连接更新服务";
  if (reason === "unsigned") return "测试安装包不会自动更新";
  if (reason === "app-store") return "请通过 App Store 获取更新";
  if (reason === "unsupported-platform") return "当前平台暂不支持自动更新";
  return "安装 DreamSkin Studio 桌面版后可用";
}

function formatUpdateBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

function SoftwareUpdateSection() {
  const updateBridge = typeof window !== "undefined" ? window.dreamskin?.updates : undefined;
  const [state, setState] = useState<SoftwareUpdateState>(browserUpdateState);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!updateBridge) {
      setState(browserUpdateState);
      return undefined;
    }
    let active = true;
    const unsubscribe = updateBridge.subscribe((next) => {
      if (active) {
        setLocalError(null);
        setState(next);
      }
    });
    void updateBridge.getState().then((next) => {
      if (active) setState(next);
    }).catch((error) => {
      if (active) setLocalError(errorMessage(error));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [updateBridge]);

  const invoke = async (action: "check" | "download" | "install") => {
    if (!updateBridge) return;
    setLocalError(null);
    try {
      const next = await updateBridge[action]();
      setState(next);
    } catch (error) {
      setLocalError(errorMessage(error));
    }
  };

  const phase = localError ? "error" : state.phase;
  const updateVersion = state.update?.version;
  const percent = Math.max(0, Math.min(100, state.progress?.percent || 0));
  const progressDetail = state.progress?.total
    ? `${formatUpdateBytes(state.progress.transferred)} / ${formatUpdateBytes(state.progress.total)}`
    : `${Math.round(percent)}%`;
  const currentVersion = state.currentVersion ? `版本 ${state.currentVersion}` : "";
  const title = phase === "checking"
    ? "正在检查更新"
    : phase === "available"
      ? `DreamSkin Studio ${updateVersion || "新版本"}`
      : phase === "downloading"
        ? `正在下载 ${updateVersion || "新版本"}`
        : phase === "ready"
          ? `${updateVersion || "新版本"} 已准备好`
          : phase === "installing"
            ? "正在准备重新启动"
            : phase === "up-to-date"
              ? "DreamSkin Studio 已是最新版本"
              : phase === "error"
                ? "无法检查更新"
                : state.enabled
                  ? "软件更新"
                  : "软件更新不可用";
  const detail = phase === "downloading"
    ? progressDetail
    : phase === "ready"
      ? "重新启动后将自动完成安装"
      : phase === "installing"
        ? "窗口即将关闭"
        : phase === "error"
          ? localError || state.error?.message || "请稍后重试"
          : phase === "up-to-date"
            ? currentVersion
            : phase === "available"
              ? [state.update?.releaseName, currentVersion].filter(Boolean).join(" · ")
              : state.enabled
                ? currentVersion
                : updateDisabledLabel(state.reason);
  const statusIcon = phase === "checking" || phase === "downloading" || phase === "installing"
    ? <LoaderCircle className="spin" size={18} />
    : phase === "ready" || phase === "up-to-date"
      ? <Check size={18} />
      : phase === "error"
        ? <CircleAlert size={18} />
        : <CloudDownload size={18} />;

  return (
    <section className="settings-section software-update-section">
      <div className="settings-title"><strong>软件更新</strong>{state.prerelease ? <span className="update-channel">预览版</span> : null}</div>
      <div className={`software-update-panel is-${phase}`} aria-live="polite">
        <span className="software-update-icon">{statusIcon}</span>
        <div className="software-update-copy"><strong>{title}</strong><small>{detail}</small></div>
        {phase === "idle" || phase === "up-to-date" || phase === "error" ? <button type="button" className="secondary-button" disabled={!state.canCheck || !updateBridge} onClick={() => void invoke("check")}>检查更新</button> : null}
        {phase === "available" ? <button type="button" className="primary-button" disabled={!state.canDownload} onClick={() => void invoke("download")}><Download size={14} />下载</button> : null}
        {phase === "ready" ? <button type="button" className="primary-button" disabled={!state.canInstall} onClick={() => void invoke("install")}><RotateCcw size={14} />重新启动并安装</button> : null}
      </div>
      {phase === "downloading" ? <div className="software-update-progress" role="progressbar" aria-label="软件下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}><i style={{ width: `${percent}%` }} /></div> : null}
    </section>
  );
}

function ThemeWorkspace({
  item,
  targetName,
  themesRoot,
  cliStatus,
  syncState,
  lastSyncAt,
  runtime,
  onBack,
  onChange,
  onApplied,
  onVerify,
  onDuplicate,
  onDelete,
  onError,
}: {
  item: LocalTheme;
  targetName: string;
  themesRoot: string;
  cliStatus: CliStatusDto | null;
  syncState: LibrarySyncState;
  lastSyncAt: number | null;
  runtime: RuntimeStatusDto | null;
  onBack: () => void;
  onChange: (item: LocalTheme) => void;
  onApplied: (item: LocalTheme) => void;
  onVerify: () => Promise<void>;
  onDuplicate: () => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onError: (title: string, detail: string) => void;
}) {
  const availableScenes = sceneOptionsForTheme(item);
  const [scene, setScene] = useState<ThemePreviewScene>(isWorkBuddyTarget(item) ? "wb-home" : "work");
  const [appearanceMode, setAppearanceMode] = useState<AppearanceMode>(item.theme.appearance.colorScheme === "dark" ? "dark" : "light");
  const [selectedComponent, setSelectedComponent] = useState<string | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [duplicateBusy, setDuplicateBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [previewZoom, setPreviewZoom] = useState<(typeof previewZoomLevels)[number]>(1);
  const workspaceBodyRef = useRef<HTMLDivElement>(null);
  const previewZoomIndex = previewZoomLevels.indexOf(previewZoom);

  useEffect(() => {
    setAppearanceMode(item.theme.appearance.colorScheme === "dark" ? "dark" : "light");
  }, [item.revisionHash, item.theme.appearance.colorScheme]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (workspaceBodyRef.current) workspaceBodyRef.current.scrollTop = 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [item.localId]);

  const apply = async () => {
    if (applyBusy) return;
    setApplyBusy(true);
    try {
      const result = await studioApi.applyTheme(item.localId, item.pluginId);
      onChange(result.theme);
      onApplied(result.theme);
    } catch (error) {
      onError("应用主题失败", errorMessage(error));
    } finally {
      setApplyBusy(false);
    }
  };

  const verify = async () => {
    if (verifyBusy) return;
    setVerifyBusy(true);
    try {
      await onVerify();
    } finally {
      setVerifyBusy(false);
    }
  };

  const duplicate = async () => {
    if (duplicateBusy) return;
    setDuplicateBusy(true);
    try {
      await onDuplicate();
    } finally {
      setDuplicateBusy(false);
    }
  };

  const deleteTheme = async () => {
    if (deleteBusy) return;
    setDeleteBusy(true);
    try {
      if (await onDelete()) setConfirmDelete(false);
    } finally {
      setDeleteBusy(false);
    }
  };

  const themeStatus = item.status === "applied" ? "使用中" : item.status === "verified" ? "已验证" : "草稿";
  const isRuntimeActive = runtime?.session === "active" && runtime.themeId === item.localId;
  const cliReady = cliStatus?.available ?? Boolean(cliStatus?.installed);
  const syncLabel = syncState === "error" ? "同步异常" : syncState === "syncing" ? "正在检查" : "已同步";
  const syncDetail = lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "等待首次检查";
  const updatedAt = new Date(item.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const colors = [
    ["强调色", item.theme.colors.accent],
    ["文字", item.theme.colors.text],
    ["面板", item.theme.colors.panel],
    ["背景", item.theme.colors.background],
  ] as const;

  return (
    <main className="theme-workspace">
      <header className="editor-toolbar">
        <div className="editor-title"><IconButton label="返回我的主题" onClick={onBack}><ArrowLeft size={16} /></IconButton><div><strong>{item.theme.name}</strong><span><i />本地主题 · v{item.revision}</span></div></div>
        <div className={`scene-tabs ${isWorkBuddyTarget(item) ? "is-workbuddy" : ""}`} role="group" aria-label={`${targetName} 预览界面`}>{availableScenes.map((option) => <button type="button" key={option.value} aria-label={option.label} aria-pressed={scene === option.value} className={scene === option.value ? "is-active" : ""} onClick={() => setScene(option.value)}>{option.icon}<span>{option.label}</span></button>)}</div>
        <div className="editor-actions"><span className={`workspace-sync-state is-${syncState}`}><i />{syncLabel}</span></div>
      </header>
      <div className="editor-body" ref={workspaceBodyRef}>
        <aside className="theme-inspector">
          <div className="theme-inspector-scroll">
            <section className="theme-inspector-summary"><span className="theme-inspector-icon">{isWorkBuddyTarget(item) ? <BriefcaseBusiness size={18} /> : <Command size={18} />}</span><div><small>{targetName}</small><strong>{item.theme.name}</strong><p>{item.theme.description || "本地自定义主题"}</p></div></section>
            <section className="theme-inspector-section"><div className="inspector-section-title"><strong>CLI 同步</strong><span className={`inspector-sync-badge is-${syncState}`}><i />{syncLabel}</span></div><div className="cli-sync-summary"><Terminal size={16} /><div><strong>{cliReady ? cliStatus?.command : cliStatus?.state === "stale" ? "DreamSkin CLI 需要更新" : cliStatus?.state === "unavailable" ? "DreamSkin CLI 不可用" : "DreamSkin CLI 未安装"}</strong><small>{cliReady ? `每 1.5 秒检查 · ${syncDetail}` : "仍会同步主题目录中的外部修改"}</small></div></div>{themesRoot ? <code className="theme-root-path" title={themesRoot}>{themesRoot}</code> : null}</section>
            <section className="theme-inspector-section"><div className="inspector-section-title"><strong>主题信息</strong></div><dl className="theme-properties"><div><dt>状态</dt><dd className={isRuntimeActive ? "is-active" : ""}>{isRuntimeActive ? "正在使用" : themeStatus}</dd></div><div><dt>版本</dt><dd>v{item.revision}</dd></div><div><dt>来源</dt><dd>{item.origin === "blank" ? "空白主题" : "模板"}</dd></div><div><dt>修改</dt><dd>{updatedAt}</dd></div><div><dt>ID</dt><dd title={item.localId}>{item.localId}</dd></div></dl></section>
            <section className="theme-inspector-section"><div className="inspector-section-title"><strong>主题色</strong></div><div className="theme-color-list">{colors.map(([label, color]) => <span key={label}><i style={{ background: color }} /><strong>{label}</strong><code>{color}</code></span>)}</div></section>
            <section className="theme-inspector-section"><div className="inspector-section-title"><strong>组件定位</strong>{selectedComponent ? <button type="button" aria-label="清除组件选择" onClick={() => setSelectedComponent(null)}><X size={13} /></button> : null}</div><div className={`component-selection ${selectedComponent ? "has-selection" : ""}`}><Boxes size={16} /><span><strong>{selectedComponent ? componentNameForTheme(item, selectedComponent) : "未选择组件"}</strong><small>{selectedComponent || "在右侧预览中选择组件"}</small></span></div></section>
          </div>
          <footer className="theme-inspector-actions">
            <button className="primary-button inspector-apply" type="button" onClick={apply} disabled={applyBusy}>{applyBusy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{applyBusy ? "应用中" : `应用到 ${targetName}`}</button>
            <div><button className="secondary-button" type="button" onClick={() => void verify()} disabled={verifyBusy || runtime?.session !== "active"}>{verifyBusy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}验证</button><button className="secondary-button" type="button" onClick={() => void duplicate()} disabled={duplicateBusy}>{duplicateBusy ? <LoaderCircle className="spin" size={14} /> : <Copy size={14} />}复制</button><button className="icon-button danger-icon-button tooltip" type="button" aria-label="删除主题" data-tooltip="删除主题" onClick={() => setConfirmDelete(true)}><Trash2 size={15} /></button></div>
            {confirmDelete ? <div className="workspace-delete-confirm" role="alertdialog" aria-label="确认删除主题"><span>删除“{item.theme.name}”？</span><div><button type="button" disabled={deleteBusy} onClick={() => setConfirmDelete(false)}>取消</button><button className="is-danger" type="button" disabled={deleteBusy} onClick={() => void deleteTheme()}>{deleteBusy ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}删除</button></div></div> : null}
          </footer>
        </aside>
        <section className="preview-pane">
          <header className="preview-toolbar"><div><span className="live-indicator"><i />本地预览</span><span>{availableScenes.find((option) => option.value === scene)?.label}</span></div><div><Segmented value={appearanceMode} onChange={setAppearanceMode} label="预览外观" options={[{ value: "light", label: "浅色" }, { value: "dark", label: "深色" }]} /><div className="preview-zoom-controls" role="group" aria-label="预览缩放"><IconButton className="zoom-button" label="缩小预览" disabled={previewZoomIndex <= 0} onClick={() => setPreviewZoom(previewZoomLevels[Math.max(0, previewZoomIndex - 1)])}><ZoomOut size={14} /></IconButton><span aria-live="polite">{Math.round(previewZoom * 100)}%</span><IconButton className="zoom-button" label="放大预览" disabled={previewZoomIndex >= previewZoomLevels.length - 1} onClick={() => setPreviewZoom(previewZoomLevels[Math.min(previewZoomLevels.length - 1, previewZoomIndex + 1)])}><ZoomIn size={14} /></IconButton><IconButton className="zoom-button" label="适合窗口" disabled={previewZoom === 1} onClick={() => setPreviewZoom(1)}><Maximize2 size={13} /></IconButton></div></div></header>
          <div className="preview-canvas"><div className="preview-surface"><Suspense fallback={<div className="preview-loading" role="status" aria-label="正在载入主题预览"><LoaderCircle className="spin" size={18} /></div>}><ThemeScenePreview theme={item.theme} appearanceMode={appearanceMode} scene={scene} targetId={item.targetId} pluginId={item.pluginId} zoom={previewZoom} interactive onComponentSelect={(id) => id && setSelectedComponent(id)} /></Suspense></div></div>
          <footer className="preview-status"><span><Monitor size={13} />{targetName} Desktop</span><span>{selectedComponent ? `已选择：${componentNameForTheme(item, selectedComponent)}` : "点击组件，或用 Tab 聚焦后按 Enter 选择"}</span><span><Check size={13} />结构有效</span></footer>
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
        <div className="detail-content"><span className="detail-target">{isWorkBuddyTarget(entry) ? <BriefcaseBusiness size={13} /> : <Command size={13} />}{entry.target || targetNameFromId(entry.targetId)} Theme</span><h2 id={titleId}>{entry.theme.name}</h2><p>{entry.theme.description}</p><div className="detail-author"><span className="author-avatar">{entry.author.trim().charAt(0).toUpperCase() || "D"}</span><div><strong>{entry.author}</strong><span>版本 {entry.version} · {entry.downloads} 次添加</span></div></div><div className="detail-tags">{entry.categories.map((category) => <span key={category}>{category}</span>)}</div><div className="coverage-list"><strong>包含界面</strong><div>{coverageForTarget(entry).map((label) => <span key={label}><Check size={13} />{label}</span>)}</div></div><button className="detail-primary" type="button" onClick={local ? onOpen : onAdd}>{local ? <Eye size={16} /> : <CloudDownload size={16} />}{local ? "打开我的主题" : "添加到我的主题"}</button></div>
      </motion.section>
    </motion.div>
  );
}

function CreateTargetDialog({
  targets,
  busyPluginId,
  onSelect,
  onClose,
}: {
  targets: TargetOption[];
  busyPluginId: string | null;
  onSelect: (pluginId: string) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyPluginId) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busyPluginId, onClose]);

  return (
    <div className="modal-backdrop create-target-backdrop" onMouseDown={() => !busyPluginId && onClose()}>
      <section className="create-target-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
        <button ref={closeRef} className="modal-close" type="button" aria-label="关闭" disabled={Boolean(busyPluginId)} onClick={onClose}><X size={17} /></button>
        <span className="dialog-kicker"><CirclePlus size={14} />新建空白主题</span>
        <h2 id={titleId}>先选择目标应用</h2>
        <p>主题会继承对应应用的页面、组件与运行规则，并保存在本机主题库中。</p>
        <div className="create-target-grid">
          {targets.map((target) => {
            const workBuddy = isWorkBuddyTarget(target);
            const busy = busyPluginId === target.pluginId;
            return (
              <button type="button" key={target.pluginId} disabled={Boolean(busyPluginId)} onClick={() => onSelect(target.pluginId)}>
                <span className={`create-target-icon ${workBuddy ? "is-workbuddy" : "is-trae"}`}>{workBuddy ? <BriefcaseBusiness size={20} /> : <Command size={20} />}</span>
                <span><strong>{target.name}</strong><small>{workBuddy ? "办公、对话、结果与自动化界面" : "Work、Code、Design 与对话界面"}</small></span>
                {busy ? <LoaderCircle className="spin" size={16} /> : <ArrowLeft className="target-arrow" size={15} />}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const desktopShell = typeof window !== "undefined" && Boolean(window.dreamskin);
  const prefersReducedMotion = useReducedMotion();
  const [view, setView] = useState<View>("library");
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [localThemes, setLocalThemes] = useState<LocalTheme[]>([]);
  const [settings, setSettings] = useState<StudioSettings>(defaultSettings);
  const [cliStatus, setCliStatus] = useState<CliStatusDto | null>(null);
  const [cliBusy, setCliBusy] = useState<"refresh" | "install" | "uninstall" | null>(null);
  const [syncState, setSyncState] = useState<LibrarySyncState>("idle");
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [inspect, setInspect] = useState<InspectDto | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatusDto | null>(null);
  const [runtimeByPlugin, setRuntimeByPlugin] = useState<Record<string, RuntimeStatusDto>>({});
  const [plugins, setPlugins] = useState<PluginDto[]>([]);
  const [targetData, setTargetData] = useState<StudioTargetDto[]>([]);
  const [activePluginId, setActivePluginId] = useState("");
  const [workspaceKey, setWorkspaceKey] = useState<string | null>(null);
  const [detailEntry, setDetailEntry] = useState<CatalogEntry | null>(null);
  const [createTargetOpen, setCreateTargetOpen] = useState(false);
  const [createTargetBusy, setCreateTargetBusy] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [bootstrapError, setBootstrapError] = useState("");
  const addingTemplatesRef = useRef(new Set<string>());
  const creatingThemeRef = useRef(false);
  const toastSequenceRef = useRef(0);
  const localThemesRef = useRef<LocalTheme[]>([]);
  const themePollBusyRef = useRef(false);
  const themePollErrorRef = useRef(false);
  const workspaceTheme = localThemes.find((item) => themeIdentity(item) === workspaceKey);
  const activePlugin = plugins.find((plugin) => plugin.id === activePluginId) || plugins.find((plugin) => plugin.active);
  const activeTargetName = activePlugin?.manifest.target.name || catalog[0]?.target || "目标应用";
  const targetOptions = useMemo<TargetOption[]>(() => {
    const options = new Map<string, TargetOption>();
    for (const target of targetData) {
      options.set(target.pluginId, { pluginId: target.pluginId, targetId: target.targetId, name: target.targetName });
    }
    for (const plugin of plugins) {
      options.set(plugin.id, { pluginId: plugin.id, targetId: plugin.manifest.target.id, name: plugin.manifest.target.name });
    }
    for (const entry of catalog) {
      if (!options.has(entry.pluginId)) options.set(entry.pluginId, { pluginId: entry.pluginId, targetId: entry.targetId, name: entry.target || targetNameFromId(entry.targetId) });
    }
    for (const item of localThemes) {
      if (!options.has(item.pluginId)) options.set(item.pluginId, { pluginId: item.pluginId, targetId: item.targetId, name: targetNameFromId(item.targetId) });
    }
    return [...options.values()];
  }, [catalog, localThemes, plugins, targetData]);
  const targetScopeKey = targetData.map((target) => target.pluginId).sort().join("|");
  const inspectByPlugin = useMemo<Record<string, InspectDto>>(() => Object.fromEntries(
    targetData.flatMap((target) => target.inspect ? [[target.pluginId, target.inspect] as const] : []),
  ), [targetData]);
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
        const targets = data.targets || [];
        const scopedPlugins = targets.map((target) => target.plugin).filter((plugin): plugin is PluginDto => Boolean(plugin));
        setBootstrapError("");
        setTargetData(targets);
        setCatalog(targets.length ? distinctCatalog(targets.flatMap((target) => target.catalog || [])) : data.catalog);
        const themes = targets.length ? distinctThemes(targets.flatMap((target) => target.themes || [])) : data.themes;
        localThemesRef.current = themes;
        setLocalThemes(themes);
        setSettings(data.settings);
        setInspect(data.inspect);
        setRuntime(data.runtime);
        setRuntimeByPlugin(Object.fromEntries(targets.flatMap((target) => target.runtime ? [[target.pluginId, target.runtime] as const] : [])));
        setPlugins([...new Map([...(data.plugins || []), ...scopedPlugins].map((plugin) => [plugin.id, plugin])).values()]);
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
    localThemesRef.current = localThemes;
  }, [localThemes]);

  useEffect(() => {
    if (bootstrapping || bootstrapError) return;
    let active = true;
    const poll = async () => {
      if (!active || themePollBusyRef.current) return;
      themePollBusyRef.current = true;
      setSyncState((current) => current === "idle" || current === "error" ? "syncing" : current);
      try {
        const pluginIds = targetData.map((target) => target.pluginId);
        const themes = pluginIds.length
          ? distinctThemes((await Promise.all(pluginIds.map((pluginId) => studioApi.listThemes(pluginId)))).flat())
          : await studioApi.listThemes();
        if (!active) return;
        const previous = localThemesRef.current;
        const previousById = new Map(previous.map((item) => [themeIdentity(item), item]));
        const nextById = new Map(themes.map((item) => [themeIdentity(item), item]));
        const added = themes.filter((item) => !previousById.has(themeIdentity(item)));
        const removed = previous.filter((item) => !nextById.has(themeIdentity(item)));
        const changed = themes.filter((item) => {
          const before = previousById.get(themeIdentity(item));
          return Boolean(before) && (before?.revisionHash !== item.revisionHash || before?.revision !== item.revision || before?.status !== item.status);
        });
        if (added.length || removed.length || changed.length) {
          localThemesRef.current = themes;
          setLocalThemes(themes);
          const removedWorkspace = workspaceKey ? removed.find((item) => themeIdentity(item) === workspaceKey) : undefined;
          const changedWorkspace = workspaceKey ? changed.find((item) => themeIdentity(item) === workspaceKey) : undefined;
          if (removedWorkspace) {
            setWorkspaceKey(null);
            setView("library");
            toast("本地主题已移除", `${removedWorkspace.theme.name} 已从主题目录中移除。`, "info");
          } else if (changedWorkspace) {
            toast("已同步外部修改", `${changedWorkspace.theme.name} 已更新到 v${changedWorkspace.revision}。`, "info");
          } else {
            const changes = [added.length ? `新增 ${added.length}` : "", changed.length ? `更新 ${changed.length}` : "", removed.length ? `移除 ${removed.length}` : ""].filter(Boolean).join(" · ");
            toast("本地主题库已更新", changes, "info");
          }
        }
        themePollErrorRef.current = false;
        setLastSyncAt(Date.now());
        setSyncState("synced");
      } catch (error) {
        if (active) {
          setSyncState("error");
          if (!themePollErrorRef.current) {
            themePollErrorRef.current = true;
            toast("同步主题失败", errorMessage(error), "error");
          }
        }
      } finally {
        themePollBusyRef.current = false;
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 1500);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [bootstrapError, bootstrapping, targetScopeKey, workspaceKey]);

  useEffect(() => {
    if (bootstrapping || bootstrapError) return;
    let active = true;
    studioApi.getCliStatus()
      .then((status) => {
        if (active) setCliStatus(status);
      })
      .catch((error) => {
        if (active) setCliStatus({ supported: false, state: "unavailable", installed: false, current: false, available: false, command: "dreamskin", path: null, targetPath: null, pathAvailable: false, message: errorMessage(error) });
      });
    return () => {
      active = false;
    };
  }, [bootstrapError, bootstrapping]);

  const openWorkspace = (item: LocalTheme) => {
    setWorkspaceKey(themeIdentity(item));
    setView("workspace");
    setDetailEntry(null);
  };

  const updateThemes = (update: (items: LocalTheme[]) => LocalTheme[]) => {
    setLocalThemes((items) => {
      const next = update(items);
      localThemesRef.current = next;
      return next;
    });
  };

  const addTemplate = async (entry: CatalogEntry) => {
    const templateKey = `${entry.pluginId}:${entry.theme.id}`;
    const existing = localThemes.find((item) => item.pluginId === entry.pluginId && item.sourceId === entry.theme.id);
    if (existing) {
      openWorkspace(existing);
      return;
    }
    if (addingTemplatesRef.current.has(templateKey)) return;
    addingTemplatesRef.current.add(templateKey);
    try {
      const local = await studioApi.createTheme({ kind: "template", sourceId: entry.theme.id, pluginId: entry.pluginId }, entry.pluginId);
      updateThemes((items) => putTheme(items, local));
      setDetailEntry(null);
      toast("已添加到我的主题", `${local.theme.name} 可以开始编辑了。`);
    } catch (error) {
      toast("添加主题失败", errorMessage(error), "error");
    } finally {
      addingTemplatesRef.current.delete(templateKey);
    }
  };

  const createBlank = async (requestedPluginId?: string) => {
    if (bootstrapping || bootstrapError || creatingThemeRef.current) return;
    const pluginId = requestedPluginId || (targetOptions.length === 1 ? targetOptions[0]?.pluginId : undefined);
    if (!pluginId) {
      setCreateTargetOpen(true);
      return;
    }
    creatingThemeRef.current = true;
    setCreateTargetBusy(pluginId);
    try {
      const local = await studioApi.createTheme({ kind: "blank", pluginId }, pluginId);
      updateThemes((items) => putTheme(items, local));
      setWorkspaceKey(themeIdentity(local));
      setView("workspace");
      setCreateTargetOpen(false);
      toast("空白主题已创建", `${targetNameForTheme(local)} 的本地主题已准备好。`);
    } catch (error) {
      toast("创建主题失败", errorMessage(error), "error");
    } finally {
      creatingThemeRef.current = false;
      setCreateTargetBusy(null);
    }
  };

  const duplicateTheme = async (item: LocalTheme) => {
    try {
      const duplicate = await studioApi.duplicateTheme(item.localId, item.pluginId);
      updateThemes((items) => putTheme(items, duplicate));
      toast("主题已复制", `${duplicate.theme.name} 已添加到我的主题。`);
      return true;
    } catch (error) {
      toast("复制主题失败", errorMessage(error), "error");
      return false;
    }
  };

  const deleteTheme = async (item: LocalTheme) => {
    try {
      await studioApi.deleteTheme(item.localId, { expectedRevision: item.revisionHash }, item.pluginId);
      updateThemes((items) => items.filter((candidate) => themeIdentity(candidate) !== themeIdentity(item)));
      if (workspaceKey === themeIdentity(item)) {
        setWorkspaceKey(null);
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
    updateThemes((items) => {
      const normalized = updated.status === "applied"
        ? items.map((item) => item.pluginId === updated.pluginId && item.localId !== updated.localId && item.status === "applied" ? { ...item, status: "verified" as const } : item)
        : items;
      return putTheme(normalized, updated);
    });
  };

  const runCliAction = async (action: "refresh" | "install" | "uninstall") => {
    if (cliBusy) return;
    setCliBusy(action);
    try {
      const status = action === "install"
        ? await studioApi.installCli()
        : action === "uninstall"
          ? await studioApi.uninstallCli()
          : await studioApi.getCliStatus();
      setCliStatus(status);
      if (action === "install") {
        if (status.state === "ready" && status.pathAvailable) {
          toast("CLI 已安装", `${status.command} 已可以在终端使用。`);
        } else if (status.state === "ready") {
          toast("CLI 已安装", status.message || "启动器已安装，但当前终端 PATH 尚未包含它的目录。", "info");
        } else if (status.state === "stale") {
          toast("CLI 需要更新", status.message || "启动器尚未更新到当前 DreamSkin 应用。", "info");
        } else {
          toast("CLI 不可用", status.message || "当前 DreamSkin 应用无法提供本地命令。", "error");
        }
      }
      if (action === "uninstall") toast("CLI 已卸载", "本地主题库和已有主题不会被删除。", "info");
    } catch (error) {
      toast(action === "install" ? "安装 CLI 失败" : action === "uninstall" ? "卸载 CLI 失败" : "刷新 CLI 状态失败", errorMessage(error), "error");
    } finally {
      setCliBusy(null);
    }
  };

  const updateSettings = async (patch: Partial<Pick<StudioSettings, "motionEnabled">>) => {
    try {
      const updated = await studioApi.updateSettings(patch);
      setSettings(updated);
    } catch (error) {
      toast("保存设置失败", errorMessage(error), "error");
    }
  };

  const verifyRuntime = async (pluginId: string) => {
    const targetName = targetOptions.find((target) => target.pluginId === pluginId)?.name || activeTargetName;
    try {
      const result = await studioApi.verifyRuntime({}, pluginId);
      const targetRuntime = runtimeByPlugin[pluginId] || (pluginId === activePluginId ? runtime : null);
      const themeName = localThemes.find((item) => item.pluginId === pluginId && item.localId === targetRuntime?.themeId)?.theme.name;
      toast("运行验证通过", themeName ? `${themeName} 的实际换肤结果正常。` : `${targetName} 主题运行正常。`);
      const themeId = result.themeId;
      if (typeof themeId === "string") {
        const next = { ...(targetRuntime || {}), available: true, session: "active", themeId };
        setRuntimeByPlugin((current) => ({ ...current, [pluginId]: next }));
        if (pluginId === activePluginId) setRuntime(next);
      }
    } catch (error) {
      toast("运行验证失败", errorMessage(error), "error");
    }
  };

  const restoreRuntime = async (pluginId: string) => {
    const targetName = targetOptions.find((target) => target.pluginId === pluginId)?.name || activeTargetName;
    try {
      const result = await studioApi.restoreRuntime(pluginId);
      const next = result.after || { available: true, session: "inactive" };
      setRuntimeByPlugin((current) => ({ ...current, [pluginId]: next }));
      if (pluginId === activePluginId) setRuntime(next);
      updateThemes((items) => items.map((item) => (
        item.pluginId === pluginId && item.status === "applied" ? { ...item, status: "verified" as const } : item
      )));
      toast("已恢复原生界面", `${targetName} 已停止使用 DreamSkin 主题。`);
    } catch (error) {
      toast("恢复原生界面失败", errorMessage(error), "error");
    }
  };

  const navigate = (target: View) => {
    if (target === "workspace" && !workspaceTheme) return;
    setView(target);
  };

  const detailLocal = detailEntry ? localThemes.find((item) => (
    item.pluginId === detailEntry.pluginId && item.sourceId === detailEntry.theme.id
  )) : undefined;

  return (
    <MotionConfig reducedMotion={motionDisabled ? "always" : "never"}>
    <div className={`studio-app ${desktopShell ? "is-desktop-shell" : ""} ${motionDisabled ? "reduce-motion" : ""}`}>
      <WindowBar view={view} workspaceTheme={workspaceTheme} syncState={syncState} onNavigate={navigate} onCreateTheme={createBlank} createDisabled={bootstrapping || Boolean(bootstrapError)} />
      <AppRail view={view} onNavigate={navigate} />
      <div className="app-content">
        {bootstrapping ? <div className="bootstrap-loading" role="status"><LoaderCircle className="spin" size={19} /><strong>正在载入 Studio</strong></div> : null}
        {!bootstrapping && bootstrapError ? <div className="bootstrap-error" role="alert"><Info size={19} /><strong>无法载入 Studio</strong><span>{bootstrapError}</span><button type="button" onClick={() => window.location.reload()}><RotateCcw size={13} />重试</button></div> : null}
        {!bootstrapping && !bootstrapError && view === "center" ? <ThemeCenter catalog={catalog} localThemes={localThemes} targets={targetOptions} onAdd={addTemplate} onOpen={openWorkspace} onInspect={setDetailEntry} /> : null}
        {!bootstrapping && !bootstrapError && view === "library" ? <MyThemes localThemes={localThemes} targets={targetOptions} targetNameForTheme={targetNameForTheme} onCreateBlank={createBlank} onOpen={openWorkspace} onDuplicate={duplicateTheme} onDelete={deleteTheme} /> : null}
        {!bootstrapping && !bootstrapError && view === "settings" ? <SettingsView settings={settings} cliStatus={cliStatus} cliBusy={cliBusy} inspect={inspect} runtime={runtime} targets={targetOptions} inspectByPlugin={inspectByPlugin} runtimeByPlugin={runtimeByPlugin} defaultPluginId={activePluginId || targetOptions[0]?.pluginId || ""} onChange={updateSettings} onCliRefresh={() => runCliAction("refresh")} onCliInstall={() => runCliAction("install")} onCliUninstall={() => runCliAction("uninstall")} onVerifyRuntime={verifyRuntime} onRestoreRuntime={restoreRuntime} /> : null}
        {!bootstrapping && !bootstrapError && view === "workspace" && workspaceTheme ? <ThemeWorkspace key={themeIdentity(workspaceTheme)} item={workspaceTheme} targetName={targetNameForTheme(workspaceTheme)} themesRoot={settings.themeRoots?.[workspaceTheme.pluginId] || targetData.find((target) => target.pluginId === workspaceTheme.pluginId)?.themesRoot || settings.themesRoot || ""} cliStatus={cliStatus} syncState={syncState} lastSyncAt={lastSyncAt} runtime={runtimeByPlugin[workspaceTheme.pluginId] || (workspaceTheme.pluginId === activePluginId ? runtime : null)} onBack={() => setView("library")} onChange={updateLocalTheme} onVerify={() => verifyRuntime(workspaceTheme.pluginId)} onDuplicate={() => duplicateTheme(workspaceTheme)} onDelete={() => deleteTheme(workspaceTheme)} onApplied={(item) => { const next = { ...(runtimeByPlugin[item.pluginId] || {}), available: true, session: "active", themeId: item.localId }; setRuntimeByPlugin((current) => ({ ...current, [item.pluginId]: next })); if (item.pluginId === activePluginId) setRuntime(next); toast("主题已应用", `${item.theme.name} 已应用到 ${targetNameForTheme(item)}。`); }} onError={(title, detail) => toast(title, detail, "error")} /> : null}
      </div>

      <AnimatePresence>
        {detailEntry ? <ThemeDetail entry={detailEntry} local={detailLocal} motionDisabled={motionDisabled} onClose={() => setDetailEntry(null)} onAdd={() => addTemplate(detailEntry)} onOpen={() => detailLocal && openWorkspace(detailLocal)} /> : null}
        {createTargetOpen ? <CreateTargetDialog targets={targetOptions} busyPluginId={createTargetBusy} onSelect={createBlank} onClose={() => setCreateTargetOpen(false)} /> : null}
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
