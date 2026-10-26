// Project model shared by the editor, the preview, the renderer and the server (engine/cadre_engine/ai/tools.py).
// All clip, subtitle and effect times are in seconds IN THE SOURCE.

export type Word = [number, number, string, number, (string | null)?]; // start, end, word, probability, person (null = main speaker)

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

// ---------- image settings (Transform, Composition, Crop, Color) — neutral values when absent
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
  x?: number; // offset as % of the width
  y?: number; // offset as % of the height
  scale?: number; // 1 = 100 %
  rotation?: number; // degrees
  flipH?: boolean;
  flipV?: boolean;
  opacity?: number; // 0..1
  blend?: string; // CSS mix-blend-mode
  crop?: { l: number; t: number; r: number; b: number }; // % cropped on each side
  color?: ColorAdj;
  chroma?: string | null; // green-screen color to key out (#00ff00)
  effects?: VFx[]; // stacked image effects (in order)
}

// ---------- image effects (general library, configurable, stackable)
export type VFxKind = 'blur' | 'sharpen' | 'glow' | 'grain' | 'pixelate' | 'rgbsplit' | 'bw' | 'sepia' | 'invert' | 'hue'
  | 'letterbox' | 'rounded' | 'border' | 'shadow' | 'motion' | 'fade' | 'mirror';
export interface VFx { id: string; kind: VFxKind; on?: boolean; p: Record<string, number | string> }
export interface EffectPreset { id: string; name: string; look: Look; createdAt?: number }

export type TransitionKind = 'fade' | 'flash' | 'zoom' | 'whip' | 'glitch' | 'blur';
export interface Transition { kind: TransitionKind; dur: number }

export interface ClipItem {
  id: string;
  before?: number; // empty gap (s) before the item on V1
  note?: string; // reason given by the AI (shown in the inspector)
  type: 'clip';
  src: string;
  in: number;
  out: number;
  label?: string;
  jump?: boolean | null;
  gap?: number; // max silence kept (s) for this clip; otherwise the pack's
  speed?: number;
  volumeDb?: number;
  captions: Caption[];
  fx: Fx[];
  face?: [number, number] | null;
  cropX?: number; // horizontal framing in vertical format (0 = left, 0.5 = center, 1 = right)
  look?: Look;
  transition?: Transition | null; // incoming transition
  fadeIn?: number; // audio fade (s)
  fadeOut?: number;
  audioOff?: boolean; // unlinked audio: played by separate audio clips (link = this clip's id)
}

export interface CardItem {
  id: string;
  before?: number; // empty gap (s) before the item on V1
  note?: string; // reason given by the AI (shown in the inspector)
  type: 'card';
  dur: number;
  text: string;
  sub?: string;
  style: 'logo' | 'twitch' | 'narr' | 'title' | 'chapter';
  image?: string | null;
  bg?: string; // background (default: black)
  color?: string; // text (default: white)
  band?: string; // band behind a title ('' = none; default: red)
  autoSfx?: boolean; // automatic sounds from the title card style (default: yes)
  sounds?: { id: string; name: string; at: number; db: number }[];
  audioOff?: boolean; // sounds unlinked: played by separate clips on A3 (link = this card's id) // sounds placed on the title card (at: s from its start)
}

export interface FreezeItem {
  id: string;
  before?: number; // empty gap (s) before the item on V1
  note?: string; // reason given by the AI (shown in the inspector)
  type: 'freeze';
  src: string;
  t: number;
  dur: number;
  target: Target;
  scale: number;
  sfx?: string | null;
  audioOff?: boolean; // sound unlinked: played by a separate clip on A3
  look?: Look;
  transition?: Transition | null;
}

export interface MediaItem {
  id: string;
  before?: number; // empty gap (s) before the item on V1
  note?: string; // reason given by the AI (shown in the inspector)
  type: 'media';
  path: string;
  url: string;
  kind: 'video' | 'audio' | 'image';
  dur: number;
  chroma?: boolean;
  volumeDb?: number;
  audioOff?: boolean; // unlinked audio
  look?: Look;
  transition?: Transition | null;
}

// ---------- free tracks (above / below the main edit), times = OUTPUT seconds
export interface TextStyle {
  font: string;
  size: number; // px at 1080
  weight: number;
  color: string;
  stroke: number;
  strokeColor: string;
  bg?: string | null;
  x: number; // center, 0..1
  y: number;
  align: 'left' | 'center' | 'right';
  anim: 'pop' | 'fade' | 'slide' | 'type' | 'none';
  uppercase?: boolean;
  italic?: boolean;
  shadow?: boolean;
  rotation?: number;
}

interface OBase { id: string; start: number; dur: number; name?: string; fadeIn?: number; fadeOut?: number; note?: string /* AI's reason */ }
export interface OVideo extends OBase { type: 'video'; src?: string; path?: string; url?: string; kind: 'video' | 'image'; in: number; speed?: number; volumeDb?: number; muted?: boolean; look?: Look }
export interface OText extends OBase { type: 'text'; text: string; style: TextStyle }
export interface OAudio extends OBase { type: 'audio'; src?: string; path?: string; url?: string; in: number; volumeDb: number; duck?: boolean; loop?: boolean;
  speed?: number; link?: string /* id of the clip / video clip this audio comes from (unlinked) */ }
export type OClip = OVideo | OText | OAudio;

export interface Track {
  id: string;
  kind: 'video' | 'text' | 'audio';
  name: string;
  locked?: boolean;
  hidden?: boolean;
  muted?: boolean;
  volumeDb?: number;
  role?: 'voice' | 'music' | 'sfx'; // tracks merged into the A1 Voice / A2 Music / A3 SFX rows
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

// ---------- AI assistant (Claude Code-style conversations)
export type AiMode = 'auto' | 'ask' | 'plan';
export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; id: string; name: string; label: string; input: Record<string, unknown>; result?: string; status: 'running' | 'done' | 'error' | 'denied' | 'pending' };
export interface Usage { input: number; output: number; cacheRead: number; cost?: number | null }
export type ConvMsg =
  | { id: string; role: 'user'; text: string; t: number; mode?: AiMode; context?: string | null }
  | { id: string; role: 'assistant'; t: number; blocks: Block[]; status: 'done' | 'error' | 'cancelled'; error?: string | null; changes?: number;
      usage?: Usage; durationMs?: number; provider?: string; mode?: AiMode;
      summary?: { k: string; a: number; b: number }[]; todos?: Todo[] };
/** step announced and checked off by the AI (etapes tool) */
export interface Todo { text: string; status: 'todo' | 'doing' | 'done' }
/** media preparation before the AI edits (download, transcription…) */
export interface PrepStage { id: string; kind: string; title: string; name: string; status: string; progress: number; detail: string }
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
  tracks?: Track[]; // index 0 = topmost track
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

// What the Remotion composition receives (preview AND render)
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
