import type { StudioTheme } from "./themes";

export type ThemeCategory = "精选" | "明星" | "美景" | "动漫" | "游戏" | "极简" | "科技" | "国风";
export type ThemeOrigin = "template" | "blank";

export interface CatalogEntry {
  pluginId: string;
  targetId: string;
  theme: StudioTheme;
  author: string;
  categories: ThemeCategory[];
  target: string;
  featured?: boolean;
  downloads: string;
  version: string;
}

export interface LocalTheme {
  pluginId: string;
  targetId: string;
  localId: string;
  sourceId?: string;
  theme: StudioTheme;
  origin: ThemeOrigin;
  updatedAt: string;
  revision: number;
  revisionHash: string;
  lastTransactionId?: string;
  status: "draft" | "verified" | "applied";
}
