import type { CatalogEntry, LocalTheme } from "./catalog";
import type { StudioTheme } from "./themes";

export interface StudioSettings {
  themesRoot: string;
  themeRoots?: Record<string, string>;
  motionEnabled: boolean;
}

export interface CliStatusDto {
  supported: boolean;
  state: "unsupported" | "unavailable" | "not-installed" | "stale" | "ready";
  installed: boolean;
  current: boolean;
  available: boolean;
  command: string;
  path: string | null;
  targetPath: string | null;
  pathAvailable: boolean;
  message?: string;
}

export interface InspectDto {
  agentToolVersion?: string;
  registry?: {
    registryVersion?: string;
    components?: unknown[];
  };
  [key: string]: unknown;
}

export interface RuntimeStatusDto {
  available?: boolean;
  session?: string;
  themeId?: string;
  hostProfile?: "solo-cn" | "international" | string;
  traeBundleId?: string;
  traeVersion?: string;
  traeDisplayName?: string;
  traeBundle?: string;
  traeExe?: string;
  error?: { code?: string; message?: string };
  [key: string]: unknown;
}

export interface PluginDto {
  id: string;
  state: string;
  active: boolean;
  manifest: {
    id: string;
    name: string;
    version: string;
    target: { id: string; name: string; platforms: string[] };
  };
}

export interface BootstrapResponse {
  catalog: CatalogEntry[];
  themes: LocalTheme[];
  plugins: PluginDto[];
  activePluginId: string;
  settings: StudioSettings;
  inspect: InspectDto;
  runtime: RuntimeStatusDto;
  targets?: StudioTargetDto[];
}

export interface StudioTargetDto {
  pluginId: string;
  targetId: string;
  targetName: string;
  plugin?: PluginDto;
  catalog: CatalogEntry[];
  themes: LocalTheme[];
  inspect?: InspectDto;
  runtime?: RuntimeStatusDto;
  components?: unknown[];
  themesRoot?: string;
}

export interface ApplyThemeResponse {
  theme: LocalTheme;
  runtime: {
    status: RuntimeStatusDto;
    [key: string]: unknown;
  };
}

export type CreateThemeInput = ({ kind: "template"; sourceId: string } | { kind: "blank" }) & {
  /** Accepted by both the legacy endpoint and scoped backends during migration. */
  pluginId?: string;
};

export interface PluginScope {
  pluginId?: string;
}

export interface UpdateThemeInput {
  theme: StudioTheme;
  expectedRevision: string;
}

export interface DeleteThemeInput {
  expectedRevision: string;
}

export interface DeleteThemeResponse {
  deleted: boolean;
  themeId: string;
}

export interface RuntimeRestoreResponse {
  restored: boolean;
  before?: RuntimeStatusDto;
  after?: RuntimeStatusDto;
  [key: string]: unknown;
}

export type SoftwareUpdatePhase =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "up-to-date"
  | "installing"
  | "error";

export interface SoftwareUpdateState {
  enabled: boolean;
  reason: string | null;
  phase: SoftwareUpdatePhase;
  currentVersion: string;
  prerelease: boolean;
  update: {
    version: string | null;
    releaseName: string | null;
    releaseDate: string | null;
  } | null;
  progress: {
    percent: number;
    transferred: number;
    total: number;
    bytesPerSecond: number;
  } | null;
  error: { code: string; message: string } | null;
  canCheck: boolean;
  canDownload: boolean;
  canInstall: boolean;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor({ code, message, status, details }: { code: string; message: string; status: number; details?: unknown }) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface StudioTransport {
  bootstrap(): Promise<BootstrapResponse>;
  listThemes(pluginId?: string): Promise<LocalTheme[]>;
  createTheme(input: CreateThemeInput, pluginId?: string): Promise<LocalTheme>;
  duplicateTheme(id: string, pluginId?: string): Promise<LocalTheme>;
  deleteTheme(id: string, input: DeleteThemeInput, pluginId?: string): Promise<DeleteThemeResponse>;
  getTheme(id: string, pluginId?: string): Promise<LocalTheme>;
  updateTheme(id: string, input: UpdateThemeInput, pluginId?: string): Promise<LocalTheme>;
  applyTheme(id: string, pluginId?: string): Promise<ApplyThemeResponse>;
  getCliStatus(): Promise<CliStatusDto>;
  installCli(): Promise<CliStatusDto>;
  uninstallCli(): Promise<CliStatusDto>;
  updateSettings(settings: Partial<Pick<StudioSettings, "motionEnabled">>): Promise<StudioSettings>;
  getRuntimeStatus(pluginId?: string): Promise<RuntimeStatusDto>;
  verifyRuntime(input?: Record<string, unknown>, pluginId?: string): Promise<Record<string, unknown>>;
  restoreRuntime(pluginId?: string): Promise<RuntimeRestoreResponse>;
}

export interface DreamSkinStudioBridge {
  bootstrap(): Promise<BootstrapResponse>;
  listCatalog(): Promise<CatalogEntry[]>;
  listThemes(pluginId?: string): Promise<LocalTheme[]>;
  createTheme(input: CreateThemeInput, pluginId?: string): Promise<LocalTheme>;
  duplicateTheme(id: string, pluginId?: string): Promise<LocalTheme>;
  deleteTheme(id: string, input: DeleteThemeInput, pluginId?: string): Promise<DeleteThemeResponse>;
  getTheme(id: string, pluginId?: string): Promise<LocalTheme>;
  updateTheme(id: string, input: UpdateThemeInput, pluginId?: string): Promise<LocalTheme>;
  applyTheme(id: string, pluginId?: string): Promise<ApplyThemeResponse>;
  validateTheme(id: string): Promise<unknown>;
  previewTheme(id: string, input?: Record<string, unknown>): Promise<unknown>;
  getCliStatus(): Promise<CliStatusDto>;
  installCli(): Promise<CliStatusDto>;
  uninstallCli(): Promise<CliStatusDto>;
  getSettings(): Promise<StudioSettings>;
  updateSettings(settings: Partial<Pick<StudioSettings, "motionEnabled">>): Promise<StudioSettings>;
  getRuntimeStatus(pluginId?: string): Promise<RuntimeStatusDto>;
  verifyRuntime(input?: Record<string, unknown>, pluginId?: string): Promise<unknown>;
  restoreRuntime(pluginId?: string): Promise<unknown>;
}

export interface DreamSkinDesktopBridge {
  getInfo(): Promise<Record<string, unknown>>;
  updates: {
    getState(): Promise<SoftwareUpdateState>;
    check(): Promise<SoftwareUpdateState>;
    download(): Promise<SoftwareUpdateState>;
    install(): Promise<SoftwareUpdateState>;
    subscribe(listener: (state: SoftwareUpdateState) => void): () => void;
  };
  studio: DreamSkinStudioBridge;
}

type ApiEnvelope<T> = {
  ok?: boolean;
  result?: T;
  error?: { code?: string; message?: string; status?: number; details?: unknown };
};

const API_ROOT = "/api/v1";

function pluginApiPath(pluginId: string | undefined, path: string) {
  return pluginId
    ? `/plugins/${encodeURIComponent(pluginId)}${path}`
    : path;
}

function unwrapEnvelope<T>(payload: unknown, fallbackStatus = 0): T {
  if (payload && typeof payload === "object" && "ok" in payload) {
    const envelope = payload as ApiEnvelope<T>;
    if (envelope.ok === true && "result" in envelope) return envelope.result as T;
    if (envelope.ok === false) {
      throw new ApiError({
        code: envelope.error?.code || "STUDIO_REQUEST_FAILED",
        message: envelope.error?.message || "DreamSkin Studio 请求失败。",
        status: envelope.error?.status ?? fallbackStatus,
        details: envelope.error?.details,
      });
    }
  }
  return payload as T;
}

function transportError(error: unknown, fallbackMessage: string) {
  if (error instanceof ApiError) return error;
  const record = error && typeof error === "object" ? error as Record<string, unknown> : null;
  return new ApiError({
    code: typeof record?.code === "string" ? record.code : "STUDIO_BACKEND_UNAVAILABLE",
    message: error instanceof Error ? error.message : typeof record?.message === "string" ? record.message : fallbackMessage,
    status: typeof record?.status === "number" ? record.status : 0,
    details: record?.details,
  });
}

async function httpRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch (error) {
    throw transportError(error, "无法连接 DreamSkin Studio 后端。");
  }

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text().catch(() => "");

  if (!response.ok) {
    const envelope = payload && typeof payload === "object" && "error" in payload
      ? (payload as ApiEnvelope<T>).error
      : undefined;
    throw new ApiError({
      code: envelope?.code || `HTTP_${response.status}`,
      message: envelope?.message || (typeof payload === "string" && payload) || `请求失败 (${response.status})`,
      status: response.status,
      details: envelope?.details,
    });
  }

  return unwrapEnvelope<T>(payload, response.status);
}

export function createHttpStudioTransport(): StudioTransport {
  return {
    bootstrap: () => httpRequest<BootstrapResponse>("/bootstrap"),
    listThemes: (pluginId) => httpRequest<LocalTheme[]>(pluginApiPath(pluginId, "/themes")),
    createTheme: (input, pluginId) => httpRequest<LocalTheme>(pluginApiPath(pluginId, "/themes"), {
      method: "POST",
      body: JSON.stringify(pluginId ? { ...input, pluginId } : input),
    }),
    duplicateTheme: (id, pluginId) => httpRequest<LocalTheme>(pluginApiPath(pluginId, `/themes/${encodeURIComponent(id)}/duplicate`), {
      method: "POST",
    }),
    deleteTheme: (id, input, pluginId) => httpRequest<DeleteThemeResponse>(pluginApiPath(pluginId, `/themes/${encodeURIComponent(id)}`), {
      method: "DELETE",
      body: JSON.stringify(input),
    }),
    getTheme: (id, pluginId) => httpRequest<LocalTheme>(pluginApiPath(pluginId, `/themes/${encodeURIComponent(id)}`)),
    updateTheme: (id, input, pluginId) => httpRequest<LocalTheme>(pluginApiPath(pluginId, `/themes/${encodeURIComponent(id)}`), {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
    applyTheme: (id, pluginId) => httpRequest<ApplyThemeResponse>(pluginApiPath(pluginId, `/themes/${encodeURIComponent(id)}/apply`), {
      method: "POST",
    }),
    getCliStatus: () => httpRequest<CliStatusDto>("/cli"),
    installCli: () => httpRequest<CliStatusDto>("/cli/install", { method: "POST" }),
    uninstallCli: () => httpRequest<CliStatusDto>("/cli/uninstall", { method: "POST" }),
    updateSettings: (settings) => httpRequest<StudioSettings>("/settings", {
      method: "PATCH",
      body: JSON.stringify(settings),
    }),
    getRuntimeStatus: (pluginId) => httpRequest<RuntimeStatusDto>(pluginApiPath(pluginId, "/runtime")),
    verifyRuntime: (input = {}, pluginId) => httpRequest<Record<string, unknown>>(pluginApiPath(pluginId, "/runtime/verify"), {
      method: "POST",
      body: JSON.stringify(input),
    }),
    restoreRuntime: (pluginId) => httpRequest<RuntimeRestoreResponse>(pluginApiPath(pluginId, "/runtime/restore"), {
      method: "POST",
    }),
  };
}

export function createElectronStudioTransport(bridge: DreamSkinStudioBridge): StudioTransport {
  const call = async <T>(invoke: () => Promise<T>) => {
    try {
      return unwrapEnvelope<T>(await invoke());
    } catch (error) {
      throw transportError(error, "无法连接 DreamSkin Studio 桌面后端。");
    }
  };

  return {
    bootstrap: () => call(() => bridge.bootstrap()),
    listThemes: (pluginId) => call(() => bridge.listThemes(pluginId)),
    createTheme: (input, pluginId) => call(() => bridge.createTheme(input, pluginId)),
    duplicateTheme: (id, pluginId) => call(() => bridge.duplicateTheme(id, pluginId)),
    deleteTheme: (id, input, pluginId) => call(() => bridge.deleteTheme(id, input, pluginId)),
    getTheme: (id, pluginId) => call(() => bridge.getTheme(id, pluginId)),
    updateTheme: (id, input, pluginId) => call(() => bridge.updateTheme(id, input, pluginId)),
    applyTheme: (id, pluginId) => call(() => bridge.applyTheme(id, pluginId)),
    getCliStatus: () => call(() => bridge.getCliStatus()),
    installCli: () => call(() => bridge.installCli()),
    uninstallCli: () => call(() => bridge.uninstallCli()),
    updateSettings: (settings) => call(() => bridge.updateSettings(settings)),
    getRuntimeStatus: (pluginId) => call(() => bridge.getRuntimeStatus(pluginId)),
    verifyRuntime: (input = {}, pluginId) => call(() => bridge.verifyRuntime(input, pluginId) as Promise<Record<string, unknown>>),
    restoreRuntime: (pluginId) => call(() => bridge.restoreRuntime(pluginId) as Promise<RuntimeRestoreResponse>),
  };
}

const httpTransport = createHttpStudioTransport();
let injectedTransport: StudioTransport | null = null;
let desktopBridge: DreamSkinStudioBridge | null = null;
let desktopTransport: StudioTransport | null = null;

function defaultTransport() {
  const nextBridge = typeof window !== "undefined" ? window.dreamskin?.studio : undefined;
  if (!nextBridge) return httpTransport;
  if (desktopBridge !== nextBridge || !desktopTransport) {
    desktopBridge = nextBridge;
    desktopTransport = createElectronStudioTransport(nextBridge);
  }
  return desktopTransport;
}

export function setStudioTransport(transport: StudioTransport | null) {
  injectedTransport = transport;
}

function transport() {
  return injectedTransport || defaultTransport();
}

export const studioApi = {
  bootstrap: () => transport().bootstrap(),
  listThemes: (pluginId?: string) => transport().listThemes(pluginId),
  createTheme: (input: CreateThemeInput, pluginId?: string) => transport().createTheme(input, pluginId),
  duplicateTheme: (id: string, pluginId?: string) => transport().duplicateTheme(id, pluginId),
  deleteTheme: (id: string, input: DeleteThemeInput, pluginId?: string) => transport().deleteTheme(id, input, pluginId),
  getTheme: (id: string, pluginId?: string) => transport().getTheme(id, pluginId),
  updateTheme: (id: string, theme: StudioTheme, expectedRevision: string, pluginId?: string) => transport().updateTheme(id, { theme, expectedRevision }, pluginId),
  applyTheme: (id: string, pluginId?: string) => transport().applyTheme(id, pluginId),
  getCliStatus: () => transport().getCliStatus(),
  installCli: () => transport().installCli(),
  uninstallCli: () => transport().uninstallCli(),
  updateSettings: (settings: Partial<Pick<StudioSettings, "motionEnabled">>) => transport().updateSettings(settings),
  getRuntimeStatus: (pluginId?: string) => transport().getRuntimeStatus(pluginId),
  verifyRuntime: (input: Record<string, unknown> = {}, pluginId?: string) => transport().verifyRuntime(input, pluginId),
  restoreRuntime: (pluginId?: string) => transport().restoreRuntime(pluginId),
};
