import { contextBridge, ipcRenderer } from "electron";

const api = {
  platform: process.platform,
  cmd: (name: string, ...args: unknown[]) => ipcRenderer.invoke("cmd", name, args),
  on: (channel: "state" | "settings" | "sound" | "open-tab", cb: (payload: any) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld("farsight", api);

export type FarSightApi = typeof api;
