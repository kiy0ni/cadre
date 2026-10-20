// Point d'entrée du rendu final (bundle Remotion) : une seule composition, taille et durée calculées depuis le projet.
import React from 'react';
import { Composition } from 'remotion';
import type { CompositionProps } from '../types';
import { Main } from './Composition';
import { resolve } from './resolve';

const EMPTY = { project: { format: { width: 1920, height: 1080, fps: 30 }, timeline: [], sources: [], music: [] } } as unknown as CompositionProps;

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Main"
    component={Main}
    defaultProps={EMPTY}
    width={1920}
    height={1080}
    fps={30}
    durationInFrames={30}
    calculateMetadata={({ props }) => {
      const r = resolve(props);
      return { durationInFrames: r.duration, width: r.width, height: r.height, fps: r.fps };
    }}
  />
);
