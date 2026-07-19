/// <reference types="vite/client" />

import type { DreamSkinDesktopBridge } from "./api";

declare global {
  interface Window {
    dreamskin?: DreamSkinDesktopBridge;
  }
}

export {};
