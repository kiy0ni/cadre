import type { Caption, EffectPreset, JobInfo, Library, Look, Pack, Project, Speaker, Word } from '../types';

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, init);
  if (res.status === 401 && url.startsWith('/api/') && !url.startsWith('/api/auth/')) {
    window.dispatchEvent(new CustomEvent('cadre-auth'));
    throw new Error('auth');
  }
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const j = await res.json();
      msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j);
    } catch { /* corps vide */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export interface AiStatus {
  provider: 'api' | 'claude-code' | null;
  api: string | null;
  claudeCode: boolean;
  settings: { provider: string; model: string; effort: string; cliModel: string };
}

export interface Render { name: string; path: string; url: string; size: number; created: number }
export interface LibraryDir { id: string; name: string; path: string; exists?: boolean | null }
export interface SystemInfo {
  app: string; version: string; platform: string; arch: string; transcription: string; voices: boolean; ffmpeg: boolean; ai: AiStatus;
  libraries: LibraryDir[]; libraryReady: boolean; dataDir: string; presets: Record<string, string>;
}
export interface ProjectRow { id: string; name: string; packId: string; updatedAt: number; createdAt: number; title: string; sources: number; items: number; thumb?: string | null }

export const api = {
  bootstrap: () => req<{ packs: Pack[]; speakers: Speaker[]; settings: Record<string, unknown>; ai: AiStatus }>('GET', '/api/bootstrap'),
  library: () => req<Library>('GET', '/api/library'),
  settings: () => req<{ settings: Record<string, unknown>; ai: AiStatus }>('GET', '/api/settings'),
  saveSettings: (s: Record<string, unknown>) => req<{ settings: Record<string, unknown>; ai: AiStatus }>('PUT', '/api/settings', s),

  system: () => req<SystemInfo>('GET', '/api/system'),
  authStatus: () => req<{ local: boolean; configured: boolean; authenticated: boolean }>('GET', '/api/auth/status'),
  login: (password: string) => req<{ ok: boolean }>('POST', '/api/auth/login', { password }),
  logout: () => req('POST', '/api/auth/logout'),
  setPassword: (password: string, current?: string) => req('POST', '/api/auth/password', { password, current }),
  addLibrary: (path: string, name?: string) => req<{ libraries: LibraryDir[] }>('POST', '/api/libraries', { path, name }),
  deleteLibrary: (id: string) => req<{ libraries: LibraryDir[] }>('DELETE', `/api/libraries/${id}`),
  rescanLibraries: () => req('POST', '/api/libraries/rescan'),
  installVoices: () => req<{ job: string }>('POST', '/api/system/voices'),
  storage: () => req<Record<string, number>>('GET', '/api/storage'),
  clearStorage: (what: string[]) => req<Record<string, number>>('POST', '/api/storage/clear', { what }),

  projects: () => req<ProjectRow[]>('GET', '/api/projects'),
  createProject: (b: { name: string; packId: string; preferences?: string; speakers?: string[] }) => req<Project>('POST', '/api/projects', b),
  project: (id: string) => req<{ project: Project; words: Record<string, Word[]>; renders: Render[] }>('GET', `/api/projects/${id}`),
  saveProject: (p: Project) => req<{ rev: number; updatedAt: number }>('PUT', `/api/projects/${p.id}`, p),
  deleteProject: (id: string) => req('DELETE', `/api/projects/${id}`),
  sources: (id: string) => req<Project['sources']>('GET', `/api/projects/${id}/sources`),
  words: (id: string, src: string) => req<Word[]>('GET', `/api/projects/${id}/words/${src}`),
  saveWords: (id: string, src: string, w: Word[]) => req('PUT', `/api/projects/${id}/words/${src}`, w),
  addSource: (id: string, b: { path?: string; paths?: string[]; url?: string; name?: string }) => req<{ source?: Project['sources'][number]; job?: string; errors?: string[] }>('POST', `/api/projects/${id}/sources`, b),
  upload: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<{ source: Project['sources'][number] }>('POST', `/api/projects/${id}/upload`, fd);
  },
  uploadLogo: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<{ logo: string; logoUrl: string }>('POST', `/api/projects/${id}/logo`, fd);
  },
  deleteSource: (id: string, src: string) => req('DELETE', `/api/projects/${id}/sources/${src}`),
  sourceAction: (id: string, src: string, action: 'proxy' | 'transcribe' | 'speakers' | 'stems') => req<{ job: string }>('POST', `/api/projects/${id}/sources/${src}/${action}`),
  moments: (id: string, src: string) => req<{ t: number; pic: number; score: number; extrait: string }[]>('GET', `/api/projects/${id}/moments/${src}`),
  autoCaptions: (id: string, b: { src: string; in: number; out: number }) => req<Caption[]>('POST', `/api/projects/${id}/captions`, b),
  ai: (id: string, b: { prompt: string; context?: Record<string, unknown>; conversation?: string | null; mode?: string }) => req<{ job: string }>('POST', `/api/projects/${id}/ai`, b),
  approve: (job: string, id: string, decision: 'allow' | 'deny' | 'always') => req('POST', `/api/jobs/${job}/approve`, { id, decision }),
  rewind: (pid: string, cid: string, messageId: string) => req<{ project: Project }>('POST', `/api/projects/${pid}/conversations/${cid}/rewind`, { messageId }),
  renameConv: (pid: string, cid: string, title: string) => req('PATCH', `/api/projects/${pid}/conversations/${cid}`, { title }),
  deleteConv: (pid: string, cid: string) => req('DELETE', `/api/projects/${pid}/conversations/${cid}`),
  render: (id: string, preset: string) => req<{ job: string }>('POST', `/api/projects/${id}/render`, { preset }),
  renders: (id: string) => req<Render[]>('GET', `/api/projects/${id}/renders`),

  jobs: (project?: string) => req<JobInfo[]>('GET', `/api/jobs${project ? `?project=${project}` : ''}`),
  job: (id: string, since = 0) => req<JobInfo>('GET', `/api/jobs/${id}?since=${since}`),
  cancelJob: (id: string) => req<JobInfo>('POST', `/api/jobs/${id}/cancel`),

  packs: () => req<Pack[]>('GET', '/api/packs'),
  createPack: (b: Partial<Pack> & { from?: string }) => req<Pack>('POST', '/api/packs', b),
  savePack: (p: Pack) => req<Pack>('PUT', `/api/packs/${p.id}`, p),
  deletePack: (id: string) => req('DELETE', `/api/packs/${id}`),
  generatePack: (b: { description: string; reference?: string; name?: string; format?: string }) => req<{ job: string }>('POST', '/api/packs/generate', b),

  presets: () => req<EffectPreset[]>('GET', '/api/presets'),
  savePreset: (name: string, look: Look) => req<EffectPreset>('POST', '/api/presets', { name, look }),
  deletePreset: (id: string) => req('DELETE', `/api/presets/${id}`),

  speakers: () => req<Speaker[]>('GET', '/api/speakers'),
  createSpeaker: (b: Partial<Speaker>) => req<Speaker>('POST', '/api/speakers', b),
  saveSpeaker: (s: Speaker) => req<Speaker>('PUT', `/api/speakers/${s.id}`, s),
  deleteSpeaker: (id: string) => req('DELETE', `/api/speakers/${id}`),
  enroll: (id: string, b: { project: string; source: string; t0: number; t1: number }) => req<{ job: string }>('POST', `/api/speakers/${id}/enroll`, b),
  record: (id: string, blob: Blob) => {
    const fd = new FormData();
    fd.append('file', blob, 'voix.webm');
    return req<{ job: string }>('POST', `/api/speakers/${id}/record`, fd);
  },
  resetVoice: (id: string) => req<Speaker>('POST', `/api/speakers/${id}/reset-voice`),
};

/** attend la fin d'une tâche en relayant ses évènements */
export async function followJob(id: string, onEvent?: (e: NonNullable<JobInfo['events']>[number], j: JobInfo) => void, onTick?: (j: JobInfo) => void): Promise<JobInfo> {
  let since = 0;
  for (;;) {
    const j = await api.job(id, since);
    for (const e of j.events || []) onEvent?.(e, j);
    since += (j.events || []).length;
    onTick?.(j);
    if (['done', 'error', 'cancelled'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 400));
  }
}
