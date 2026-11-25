export type { AnchorTier, DiffSide, OrphanReason, TrackedAnchor } from '../../shared/model';

export interface AnchorConfig {
  placeThreshold: number;
  guessThreshold: number;
  radius: number;
  ambiguityMargin: number;
  contextLines: number;
}

export const DEFAULT_ANCHOR_CONFIG: AnchorConfig = {
  placeThreshold: 0.7,
  guessThreshold: 0.5,
  radius: 250,
  ambiguityMargin: 0.05,
  contextLines: 4,
};
