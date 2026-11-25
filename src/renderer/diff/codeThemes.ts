import { registerCustomTheme } from '@pierre/diffs';
import type { ThemeRegistration } from 'shiki';

/**
 * Hydra Plus MD (and its Italic variant) by juanmnl, MIT (hydra/LICENSE.txt): the code theme of the Slate app theme.
 * The token colours are Hydra's own; the background and the added/removed/modified colours are Slate's, so the diff
 * sits flush in the Slate panels. Registered on the main thread; Pierre sends resolved themes to its highlight workers.
 */
const SLATE_EDITOR = {
  'editor.background': '#242533',
  'gitDecoration.addedResourceForeground': '#7ddc9f',
  'gitDecoration.deletedResourceForeground': '#ff7a98',
  'gitDecoration.modifiedResourceForeground': '#41bfff',
};

/** Shiki only uses the colours and TextMate rules; VS Code's semantic token colours have no equivalent there. */
function hydra(name: string, load: () => Promise<{ default: Pick<ThemeRegistration, 'colors' | 'tokenColors'> }>): void {
  registerCustomTheme(name, async () => {
    const { colors, tokenColors } = (await load()).default;
    return { name, type: 'dark', colors: { ...colors, ...SLATE_EDITOR }, tokenColors };
  });
}

hydra('hydra-plus-md', () => import('./hydra/hydra-plus-md.json'));
hydra('hydra-plus-md-italic', () => import('./hydra/hydra-plus-md-italic.json'));
