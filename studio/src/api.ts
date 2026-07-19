import type { CatalogEntry, LocalTheme } from "./catalog";
import type { StudioTheme } from "./themes";

export type AgentState = "connected" | "detected" | "missing" | "error" | string;

export interface AgentDto {
  id: string;
  name: string;
  command: string;
  version?: string | null;
  state: AgentState;
  initial?: string;
  error?: string;
  capabilities?: {
    acp?: boolean;
    tool?: boolean;
    toolTransport?: "native" | "acp" | "stdio-compat" | string | null;
  };
}

export interface AgentConnection {
  agentId: string | null;
  state: "connected" | "connecting" | "disconnected" | "error" | string;
}

export interface StudioSettings {
  themesRoot: string;
  autoVerify: boolean;
  motionEnabled: boolean;
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
  agents: AgentDto[];
  connection: AgentConnection;
  plugins: PluginDto[];
  activePluginId: string;
  settings: StudioSettings;
  inspect: InspectDto;
  runtime: RuntimeStatusDto;
}

export interface AgentConnectionResponse {
  agents: AgentDto[];
  connection: AgentConnection;
}

export interface ApplyThemeResponse {
  theme: LocalTheme;
  runtime: unknown;
}

export interface ThemeMessageResponse {
  theme: LocalTheme;
  message: string;
  changes: string[];
  sessionId: string;
  stopReason: string;
}

export type CreateThemeInput = { kind: "template"; sourceId: string } | { kind: "blank" };

export interface UpdateThemeInput {
  theme: StudioTheme;
  expectedRevision: string;
}

export interface ThemeMessageInput {
  prompt: string;
  componentId?: string;
  agentId?: string;
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
  listThemes(): Promise<LocalTheme[]>;
  createTheme(input: CreateThemeInput): Promise<LocalTheme>;
  duplicateTheme(id: string): Promise<LocalTheme>;
  deleteTheme(id: string, input: DeleteThemeInput): Promise<DeleteThemeResponse>;
  getTheme(id: string): Promise<LocalTheme>;
  updateTheme(id: string, input: UpdateThemeInput): Promise<LocalTheme>;
  applyTheme(id: string): Promise<ApplyThemeResponse>;
  sendThemeMessage(id: string, input: ThemeMessageInput): Promise<ThemeMessageResponse>;
  listAgents(): Promise<AgentDto[]>;
  connectAgent(id: string): Promise<AgentConnectionResponse>;
  updateSettings(settings: Partial<Pick<StudioSettings, "autoVerify" | "motionEnabled">>): Promise<StudioSettings>;
  verifyRuntime(input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  restoreRuntime(): Promise<RuntimeRestoreResponse>;
}

export interface DreamSkinStudioBridge {
  bootstrap(): Promise<BootstrapResponse>;
  listCatalog(): Promise<CatalogEntry[]>;
  listThemes(): Promise<LocalTheme[]>;
  createTheme(input: CreateThemeInput): Promise<LocalTheme>;
  duplicateTheme(id: string): Promise<LocalTheme>;
  deleteTheme(id: string, input: DeleteThemeInput): Promise<DeleteThemeResponse>;
  getTheme(id: string): Promise<LocalTheme>;
  updateTheme(id: string, input: UpdateThemeInput): Promise<LocalTheme>;
  applyTheme(id: string): Promise<ApplyThemeResponse>;
  validateTheme(id: string): Promise<unknown>;
  previewTheme(id: string, input?: Record<string, unknown>): Promise<unknown>;
  sendThemeMessage(id: string, input: ThemeMessageInput): Promise<ThemeMessageResponse>;
  listAgents(): Promise<AgentDto[]>;
  connectAgent(id: string): Promise<AgentConnectionResponse>;
  getSettings(): Promise<StudioSettings>;
  updateSettings(settings: Partial<Pick<StudioSettings, "autoVerify" | "motionEnabled">>): Promise<StudioSettings>;
  verifyRuntime(input?: Record<string, unknown>): Promise<unknown>;
  restoreRuntime(): Promise<unknown>;
}

export interface DreamSkinDesktopBridge {
  getInfo(): Promise<Record<string, unknown>>;
  studio: DreamSkinStudioBridge;
}

type ApiEnvelope<T> = {
  ok?: boolean;
  result?: T;
  error?: { code?: string; message?: string; status?: number; details?: unknown };
};

const API_ROOT = "/api/v1";

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
    listThemes: () => httpRequest<LocalTheme[]>("/themes"),
    createTheme: (input) => httpRequest<LocalTheme>("/themes", {
      method: "POST",
      body: JSON.stringify(input),
    }),
    duplicateTheme: (id) => httpRequest<LocalTheme>(`/themes/${encodeURIComponent(id)}/duplicate`, {
      method: "POST",
    }),
    deleteTheme: (id, input) => httpRequest<DeleteThemeResponse>(`/themes/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify(input),
    }),
    getTheme: (id) => httpRequest<LocalTheme>(`/themes/${encodeURIComponent(id)}`),
    updateTheme: (id, input) => httpRequest<LocalTheme>(`/themes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
    applyTheme: (id) => httpRequest<ApplyThemeResponse>(`/themes/${encodeURIComponent(id)}/apply`, {
      method: "POST",
    }),
    sendThemeMessage: (id, input) => httpRequest<ThemeMessageResponse>(`/themes/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
    listAgents: () => httpRequest<AgentDto[]>("/agents"),
    connectAgent: (id) => httpRequest<AgentConnectionResponse>(`/agents/${encodeURIComponent(id)}/connect`, {
      method: "POST",
    }),
    updateSettings: (settings) => httpRequest<StudioSettings>("/settings", {
      method: "PATCH",
      body: JSON.stringify(settings),
    }),
    verifyRuntime: (input = {}) => httpRequest<Record<string, unknown>>("/runtime/verify", {
      method: "POST",
      body: JSON.stringify(input),
    }),
    restoreRuntime: () => httpRequest<RuntimeRestoreResponse>("/runtime/restore", {
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
    listThemes: () => call(() => bridge.listThemes()),
    createTheme: (input) => call(() => bridge.createTheme(input)),
    duplicateTheme: (id) => call(() => bridge.duplicateTheme(id)),
    deleteTheme: (id, input) => call(() => bridge.deleteTheme(id, input)),
    getTheme: (id) => call(() => bridge.getTheme(id)),
    updateTheme: (id, input) => call(() => bridge.updateTheme(id, input)),
    applyTheme: (id) => call(() => bridge.applyTheme(id)),
    sendThemeMessage: (id, input) => call(() => bridge.sendThemeMessage(id, input)),
    listAgents: () => call(() => bridge.listAgents()),
    connectAgent: (id) => call(() => bridge.connectAgent(id)),
    updateSettings: (settings) => call(() => bridge.updateSettings(settings)),
    verifyRuntime: (input = {}) => call(() => bridge.verifyRuntime(input) as Promise<Record<string, unknown>>),
    restoreRuntime: () => call(() => bridge.restoreRuntime() as Promise<RuntimeRestoreResponse>),
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
  listThemes: () => transport().listThemes(),
  createTheme: (input: CreateThemeInput) => transport().createTheme(input),
  duplicateTheme: (id: string) => transport().duplicateTheme(id),
  deleteTheme: (id: string, input: DeleteThemeInput) => transport().deleteTheme(id, input),
  getTheme: (id: string) => transport().getTheme(id),
  updateTheme: (id: string, theme: StudioTheme, expectedRevision: string) => transport().updateTheme(id, { theme, expectedRevision }),
  applyTheme: (id: string) => transport().applyTheme(id),
  sendThemeMessage: (id: string, input: ThemeMessageInput) => transport().sendThemeMessage(id, input),
  listAgents: () => transport().listAgents(),
  connectAgent: (id: string) => transport().connectAgent(id),
  updateSettings: (settings: Partial<Pick<StudioSettings, "autoVerify" | "motionEnabled">>) => transport().updateSettings(settings),
  verifyRuntime: (input: Record<string, unknown> = {}) => transport().verifyRuntime(input),
  restoreRuntime: () => transport().restoreRuntime(),
};
