import type { Draft, DraftOrigin } from './model';

/**
 * A draft an agent wrote that you haven't edited. It goes out with your review like your own; agents may still change
 * or delete it, and once you edit it, it is yours.
 */
export const isAgentDraft = (d: Draft): d is Draft & { origin: DraftOrigin } => d.origin !== undefined;
