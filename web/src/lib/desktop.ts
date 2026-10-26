// Bridge to the desktop app (Electron, desktop/preload.cjs). Absent in a browser: everything remains usable.
export interface DesktopBridge {
  platform: string;
  pickFiles: (opts?: { images?: boolean }) => Promise<string[]>;
  pickFolder?: () => Promise<string | null>;
  setZoom?: (z: number) => void;
  pathForFile: (f: File) => string;
  reveal: (path: string) => void;
  openExternal: (url: string) => void;
  onMenu: (cb: (action: string) => void) => () => void;
}

declare global { interface Window { cadre?: DesktopBridge } }

export const desktop = (): DesktopBridge | undefined => window.cadre;
export const isDesktop = () => !!window.cadre;
