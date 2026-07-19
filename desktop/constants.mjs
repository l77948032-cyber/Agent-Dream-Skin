export const DREAMSKIN_SCHEME = "dreamskin";
export const DREAMSKIN_HOST = "studio";
export const DREAMSKIN_ORIGIN = `${DREAMSKIN_SCHEME}://${DREAMSKIN_HOST}`;
export const DREAMSKIN_START_URL = `${DREAMSKIN_ORIGIN}/`;

export const IPC_CHANNELS = Object.freeze({
  desktopInfo: "dreamskin:desktop-info",
  studioApi: "dreamskin:studio-api",
});

export const MAX_DESKTOP_PAYLOAD_BYTES = 1024 * 1024;
