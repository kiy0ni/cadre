// 24 px line icons (drawn here: no dependency).
import type { SVGProps } from 'react';

const P: Record<string, string> = {
  logo: 'M4 4h6 M4 4v6 M20 4h-6 M20 4v6 M4 20h6 M4 20v-6 M20 20h-6 M20 20v-6',
  home: 'M3 11l9-7 9 7 M5 10v10h14V10',
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  media: 'M3 5h18v14H3z M3 9h18 M8 5v4 M16 5v4',
  film: 'M4 3h16v18H4z M8 3v18 M16 3v18 M4 8h4 M4 13h4 M16 8h4 M16 13h4 M4 18h4 M16 18h4',
  image: 'M3 4h18v16H3z M8.5 10a1.5 1.5 0 1 0 0-.01 M21 16l-5-5L5 20',
  music: 'M9 18V5l12-2v13 M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  audio: 'M2 12h2 M6 8v8 M10 4v16 M14 7v10 M18 10v4 M22 12h-2',
  text: 'M4 7V4h16v3 M9 20h6 M12 4v16',
  style: 'M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z',
  assistant: 'M4 5h16v11H9l-5 4z M8 10h.01 M12 10h.01 M16 10h.01',
  transition: 'M3 12h7 M14 12h7 M8 7l-5 5 5 5 M16 7l5 5-5 5',
  captions: 'M3 5h18v14H3z M7 15h4 M13 15h4 M7 11h10',
  people: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M22 21v-2a4 4 0 0 0-3-3.9 M16 3.1a4 4 0 0 1 0 7.8',
  sliders: 'M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  play: 'M7 4.5l12 7.5-12 7.5z',
  pause: 'M7 4h3v16H7z M14 4h3v16h-3z',
  start: 'M5 4v16 M19 4L9 12l10 8z',
  end: 'M19 4v16 M5 4l10 8-10 8z',
  prev: 'M6 5v14 M18 5l-9 7 9 7z',
  next: 'M18 5v14 M6 5l9 7-9 7z',
  stepb: 'M11 6l-6 6 6 6 M19 6l-6 6 6 6',
  stepf: 'M13 6l6 6-6 6 M5 6l6 6-6 6',
  loop: 'M17 2l4 4-4 4 M3 11V9a3 3 0 0 1 3-3h15 M7 22l-4-4 4-4 M21 13v2a3 3 0 0 1-3 3H3',
  volume: 'M11 5L6 9H2v6h4l5 4z M15.5 8.5a5 5 0 0 1 0 7 M19 5a10 10 0 0 1 0 14',
  mute: 'M11 5L6 9H2v6h4l5 4z M23 9l-6 6 M17 9l6 6',
  full: 'M8 3H3v5 M16 3h5v5 M8 21H3v-5 M16 21h5v-5',
  lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
  unlock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 7.7-1.5',
  eye: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
  eyeoff: 'M17.9 17.9A10 10 0 0 1 12 19c-7 0-11-7-11-7a18 18 0 0 1 5.1-5.9 M9.9 4.2A9 9 0 0 1 12 4c7 0 11 7 11 7a18 18 0 0 1-2.2 3.2 M1 1l22 22',
  cursor: 'M5 3l6 17 2.5-7.5L21 10z',
  razor: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M20 4L8.1 15.9 M14.5 14.5L20 20 M8.1 8.1L12 12',
  magnet: 'M6 3v8a6 6 0 0 0 12 0V3 M6 3h4v8a2 2 0 0 0 4 0V3h4 M6 7h4 M14 7h4',
  undo: 'M9 14L4 9l5-5 M4 9h11a5 5 0 0 1 0 10h-4',
  redo: 'M15 14l5-5-5-5 M20 9H9a5 5 0 0 0 0 10h4',
  trash: 'M3 6h18 M8 6V4h8v2 M19 6l-1 14H6L5 6',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  marker: 'M6 3h12v13l-6 5-6-5z',
  zoomin: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14 M21 21l-4.3-4.3 M11 8v6 M8 11h6',
  zoomout: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14 M21 21l-4.3-4.3 M8 11h6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14 M21 21l-4.3-4.3',
  share: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M8.6 13.5l6.8 4 M15.4 6.5l-6.8 4',
  export: 'M12 15V3 M7 8l5-5 5 5 M5 21h14 M5 15v6 M19 15v6',
  download: 'M12 3v12 M7 10l5 5 5-5 M5 21h14',
  import: 'M12 3v12 M7 10l5 5 5-5 M4 17v4h16v-4',
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3 M19 10v2a7 7 0 0 1-14 0v-2 M12 19v3',
  back: 'M15 18l-6-6 6-6',
  chev: 'M6 9l6 6 6-6',
  chevr: 'M9 6l6 6-6 6',
  edit: 'M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  check: 'M20 6L9 17l-5-5',
  x: 'M18 6L6 18 M6 6l12 12',
  split: 'M12 2v20 M5 7l-3 5 3 5 M19 7l3 5-3 5',
  layers: 'M12 2L2 7l10 5 10-5z M2 17l10 5 10-5 M2 12l10 5 10-5',
  copy: 'M9 9h12v12H9z M5 15H3V3h12v2',
  folder: 'M3 6h6l2 2h10v11H3z',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7 M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  color: 'M12 22a10 10 0 1 1 0-20c5.5 0 10 4 10 9a5 5 0 0 1-5 5h-2a2 2 0 0 0-1 3.7A1.5 1.5 0 0 1 12 22z M7.5 10.5h.01 M12 7.5h.01 M16.5 10.5h.01',
  fit: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
  target: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M12 12h.01',
  face: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 M8 14s1.5 2 4 2 4-2 4-2 M9 9h.01 M15 9h.01',
  shake: 'M2 12h3l2-5 3 10 3-12 3 10 2-3h4',
  contrast: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 M12 2v20',
  zap: 'M13 2L3 14h9l-1 8 10-12h-9z',
  bold: 'M6 4h8a4 4 0 0 1 0 8H6z M6 12h9a4 4 0 0 1 0 8H6z',
  fast: 'M13 19l9-7-9-7z M2 19l9-7-9-7z',
  bleep: 'M11 5L6 9H2v6h4l5 4z M16 9l4 6 M20 9l-4 6',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5 M12 7v5l3 3',
  keyboard: 'M2 6h20v12H2z M6 10h.01 M10 10h.01 M14 10h.01 M18 10h.01 M7 14h10',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 M12 16v-4 M12 8h.01',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  panel: 'M3 4h18v16H3z M15 4v16',
  mark_in: 'M8 4v16 M8 4h6 M8 20h6',
  mark_out: 'M16 4v16 M16 4h-6 M16 20h-6',
  insert: 'M12 4v10 M8 10l4 4 4-4 M3 18h7 M14 18h7 M12 18v2',
  overwrite: 'M12 4v10 M8 10l4 4 4-4 M3 18h18',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 M2 12h20 M12 2a15 15 0 0 1 0 20 M12 2a15 15 0 0 0 0 20',
  cpu: 'M5 5h14v14H5z M9 9h6v6H9z M9 1v4 M15 1v4 M9 19v4 M15 19v4 M1 9h4 M1 15h4 M19 9h4 M19 15h4',
  freeze: 'M12 2v20 M2 12h20 M5 5l14 14 M19 5L5 19',
  scope: 'M3 3v18h18 M7 15l4-6 4 4 5-7',
  wand: 'M15 4V2 M15 16v-2 M8 9h2 M20 9h2 M17.8 11.8l1.4 1.4 M17.8 6.2l1.4-1.4 M12.2 6.2l-1.4-1.4 M3 21l9-9',
  stop: 'M6 6h12v12H6z',
  send: 'M12 19V5 M5 12l7-7 7 7',
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 16, ...rest }: { name: string; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      <path d={P[name] || P.plus} />
    </svg>
  );
}

/** app logo: four frame corners */
export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <rect x="1" y="1" width="22" height="22" rx="5" fill="var(--accent)" />
      <path d="M6.5 9.5V6.5h3 M17.5 9.5V6.5h-3 M6.5 14.5v3h3 M17.5 14.5v3h-3" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
