// Modèle de projet partagé par l'éditeur, l'aperçu, le rendu et le serveur (server/ai/tools.py).
// Tous les temps des plans, sous-titres et effets sont en secondes DANS LA SOURCE.

export type Word = [number, number, string, number, (string | null)?]; // début, fin, mot, proba, personne (null = principale)

export type SourceStatus = 'none' | 'running' | 'done' | 'error';

export interface Source {
  id: string;
  name: string;
  path: string;
  url: string;
  origin?: string | null;
  kind: 'video' | 'audio' | 'image';
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  proxy?: string | null;
  stems?: { voice: string; game: string; gameMedianDb: number } | null;
  status: { transcript: SourceStatus; speakers: SourceStatus; stems: SourceStatus; proxy: SourceStatus };
}

export type Target = 'face' | 'center' | [number, number];

export type Fx =
  | { id: string; kind: 'zoom'; t0: number; t1: number; target: Target; scale: number }
  | { id: string; kind: 'shake'; t0: number; t1: number; amp: number }
  | { id: string; kind: 'tint'; t0: number; t1: number; mode: 'bw' | 'red' | 'flash' }
  | { id: string; kind: 'sfx'; t: number; name: string; db: number }
  | { id: string; kind: 'text'; t: number; dur: number; text: string; style: 'big' | 'note' | 'rip' }
  | { id: string; kind: 'cut'; t0: number; t1: number }
  | { id: string; kind: 'keep'; t0: number; t1: number }
  | { id: string; kind: 'speed'; t0: number; t1: number; rate: number }
  | { id: string; kind: 'censor'; t0: number; t1: number };

export type FxKind = Fx['kind'];

export interface Caption {
  id: string;
  t0: number;
  t1: number;
  text: string;
  speaker: string | null;
  style: 'normal' | 'hype' | 'shout';
}

// ---------- réglages d'image (Transform, Composition, Recadrage, Couleur) — valeurs neutres si absentes
export interface ColorAdj {
  preset?: string;
  exposure?: number; // -100..100
  contrast?: number;
  saturation?: number;
  temperature?: number;
  tint?: number;
  highlights?: number;
  shadows?: number;
  vignette?: number; // 0..100
}

export interface Look {
  x?: number; // décalage en % de la largeur
  y?: number; // décalage en % de la hauteur
  scale?: number; // 1 = 100 %
  rotation?: number; // degrés
  flipH?: boolean;
  flipV?: boolean;
  opacity?: number; // 0..1
  blend?: string; // mix-blend-mode CSS
  crop?: { l: number; t: number; r: number; b: number }; // % rognés de chaque côté
  color?: ColorAdj;
  chroma?: string | null; // couleur du fond vert à retirer (#00ff00)
  effects?: VFx[]; // effets d'image empilés (dans l'ordre)
}

// ---------- effets d'image (bibliothèque générale, paramétrables, cumulables)
export type VFxKind = 'blur' | 'sharpen' | 'glow' | 'grain' | 'pixelate' | 'rgbsplit' | 'bw' | 'sepia' | 'invert' | 'hue'
  | 'letterbox' | 'rounded' | 'border' | 'shadow' | 'motion' | 'fade' | 'mirror';
export interface VFx { id: string; kind: VFxKind; on?: boolean; p: Record<string, number | string> }
export interface EffectPreset { id: string; name: string; look: Look; createdAt?: number }

export type TransitionKind = 'fade' | 'flash' | 'zoom' | 'whip' | 'glitch' | 'blur';
export interface Transition { kind: TransitionKind; dur: number }

export interface ClipItem {
  id: string;
  type: 'clip';
  src: string;
  in: number;
  out: number;
  label?: string;
  jump?: boolean | null;
  gap?: number; // silence max gardé (s) pour ce plan ; sinon celui du pack
  speed?: number;
  volumeDb?: number;
  captions: Caption[];
  fx: Fx[];
  face?: [number, number] | null;
  cropX?: number; // recadrage horizontal en vertical (0 = gauche, 0.5 = centre, 1 = droite)
  look?: Look;
  transition?: Transition | null; // transition d'entrée
  fadeIn?: number; // fondu audio (s)
  fadeOut?: number;
}

export interface CardItem {
  id: string;
  type: 'card';
  dur: number;
  text: string;
  sub?: string;
  style: 'logo' | 'twitch' | 'narr' | 'title' | 'chapter';
  image?: string | null;
  autoSfx?: boolean; // sons automatiques du style de carton (défaut : oui)
  sounds?: { id: string; name: string; at: number; db: number }[]; // sons posés sur le carton (at : s depuis son début)
}

export interface FreezeItem {
  id: string;
  type: 'freeze';
  src: string;
  t: number;
  dur: number;
  target: Target;
  scale: number;
  sfx?: string | null;
  look?: Look;
  transition?: Transition | null;
}

export interface MediaItem {
  id: string;
  type: 'media';
  path: string;
  url: string;
  kind: 'video' | 'audio' | 'image';
  dur: number;
  chroma?: boolean;
  volumeDb?: number;
  look?: Look;
  transition?: Transition | null;
}

// ---------- pistes libres (au-dessus / en dessous du montage principal), temps = secondes de SORTIE
export interface TextStyle {
  font: string;
  size: number; // px en 1080
  weight: number;
  color: string;
  stroke: number;
  strokeColor: string;
  bg?: string | null;
  x: number; // centre, 0..1
  y: number;
  align: 'left' | 'center' | 'right';
  anim: 'pop' | 'fade' | 'slide' | 'type' | 'none';
  uppercase?: boolean;
  italic?: boolean;
  shadow?: boolean;
  rotation?: number;
}

interface OBase { id: string; start: number; dur: number; name?: string; fadeIn?: number; fadeOut?: number }
export interface OVideo extends OBase { type: 'video'; src?: string; path?: string; url?: string; kind: 'video' | 'image'; in: number; speed?: number; volumeDb?: number; muted?: boolean; look?: Look }
export interface OText extends OBase { type: 'text'; text: string; style: TextStyle }
export interface OAudio extends OBase { type: 'audio'; src?: string; path?: string; url?: string; in: number; volumeDb: number; duck?: boolean }
export type OClip = OVideo | OText | OAudio;

export interface Track {
  id: string;
  kind: 'video' | 'text' | 'audio';
  name: string;
  locked?: boolean;
  hidden?: boolean;
  muted?: boolean;
  volumeDb?: number;
  role?: 'voice' | 'music' | 'sfx'; // pistes intégrées aux lignes A1 Voix / A2 Musique / A3 Bruitages
  clips: OClip[];
}

export interface Mix { voiceMuted?: boolean; musicMuted?: boolean; sfxMuted?: boolean; captionsHidden?: boolean; mainHidden?: boolean; voiceDb?: number; musicDb?: number; sfxDb?: number }

export type Item = ClipItem | CardItem | FreezeItem | MediaItem;

export interface MusicCue {
  id: string;
  name: string;
  url: string;
  gainDb: number;
  db: number;
  fromItem: string;
  toItem: string;
  offset?: number;
}

export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  t: number;
  changes?: number;
  provider?: string;
}

// ---------- assistant IA (conversations façon Claude Code)
export type AiMode = 'auto' | 'ask' | 'plan';
export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; id: string; name: string; label: string; input: Record<string, unknown>; result?: string; status: 'running' | 'done' | 'error' | 'denied' | 'pending' };
export interface Usage { input: number; output: number; cacheRead: number; cost?: number | null }
export type ConvMsg =
  | { id: string; role: 'user'; text: string; t: number; mode?: AiMode; context?: string | null }
  | { id: string; role: 'assistant'; t: number; blocks: Block[]; status: 'done' | 'error' | 'cancelled'; error?: string | null; changes?: number;
      usage?: Usage; durationMs?: number; provider?: string; mode?: AiMode };
export interface Conversation { id: string; title: string; createdAt: number; updatedAt: number; sessionId?: string; provider?: string; messages: ConvMsg[] }

export interface Project {
  version: number;
  id: string;
  rev: number;
  name: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  packId: string;
  preferences: string;
  overrides?: Partial<PackStyle>;
  format: { width: number; height: number; fps: number };
  speakers: string[];
  defaultSpeaker: string | null;
  glossary: Record<string, string>;
  sources: Source[];
  timeline: Item[];
  music: MusicCue[];
  tracks?: Track[]; // index 0 = piste la plus haute
  mix?: Mix;
  markers?: { id: string; t: number; label: string; color?: string }[];
  chat: ChatMsg[];
  conversations?: Conversation[];
  logo?: string;
  logoUrl?: string;
}

export interface CaptionStyle {
  font: string;
  weight: number;
  size: number;
  color: string;
  outline: number;
  shadow: number;
  bottom: number;
  mode: 'groups' | 'words';
  wordsPerCaption?: number;
  uppercase: boolean;
  pop: boolean;
  shoutScale: number;
  maxChars: number;
  box?: boolean;
}

export interface PackStyle {
  captions: CaptionStyle;
  jumpCuts: { enabled: boolean; gap: number; pre: number; post: number };
  baseSpeed: number;
  face: [number, number];
  zoom: { face: number; center: number };
  shakeOnImpact: boolean;
  whooshOnFaceZoom: boolean;
  music: { db: number; duckDb: number };
  sfxDb: number;
  censor: { captions: boolean; audio: boolean; duckDb: number };
  stems: { enabled: boolean; gameBoostDb: number; gameUnderVoiceDb: number };
  cards: { twitchHandle: string; twitchColor: string };
  topText: string;
  topTextColor?: string;
  loudness: number;
}

export interface Pack {
  id: string;
  name: string;
  emoji?: string;
  description: string;
  format: { width: number; height: number; fps: number };
  speakers: string[];
  defaultSpeaker: string | null;
  whisper: { language: string; prompt: string };
  rules: string;
  structure: string;
  style: PackStyle;
  outro?: string;
}

export interface Speaker {
  id: string;
  name: string;
  color: string;
  aliases: string[];
  description: string;
  preferences: string;
  samples: { project?: string; source?: string; t0?: number; t1?: number; file?: string; windows: number }[];
  hasVoice: boolean;
}

export interface SfxVariant {
  file: string;
  url: string;
  start: number;
  dur: number;
  anchor: number;
  gainDb: number;
}

export interface SfxType {
  name: string;
  help: string;
  variants: SfxVariant[];
}

export interface MusicTrack {
  name: string;
  file: string;
  url: string;
  moods: string[];
  energy: string;
  bpm: number;
  genres: string[];
  gainDb: number;
}

export interface Library {
  sfx: Record<string, SfxType>;
  music: MusicTrack[];
  vfx: { name: string; path: string; url: string; folder: string }[];
  sections: Record<string, string[]>;
}

export interface JobInfo {
  id: string;
  kind: string;
  project: string | null;
  label: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  message: string;
  error: string | null;
  created: number;
  meta: Record<string, unknown>;
  result: unknown;
  events?: JobEvent[];
}

export type JobEvent = { i: number; type: string; t: number; [k: string]: unknown };

// Ce que la composition Remotion reçoit (aperçu ET rendu)
export interface CompositionProps {
  project: Project;
  words: Record<string, Word[]>;
  pack: { id: string; style: PackStyle };
  speakers: Record<string, { name: string; color: string }>;
  sfx: Record<string, SfxType>;
  logo?: string | null;
  mode: 'preview' | 'render';
  [key: string]: unknown;
}
