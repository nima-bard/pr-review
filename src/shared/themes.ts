/** Syntax themes for the diff and file views: Shiki's bundled themes plus Pierre's own and Hydra (renderer/diff/codeThemes.ts); GitHub's is the default. */
export const DARK_CODE_THEMES = [
  'github-dark-default',
  'github-dark',
  'pierre-dark',
  'hydra-plus-md',
  'hydra-plus-md-italic',
  'github-dark-dimmed',
  'github-dark-high-contrast',
  'dark-plus',
  'one-dark-pro',
  'dracula',
  'dracula-soft',
  'tokyo-night',
  'catppuccin-mocha',
  'catppuccin-macchiato',
  'catppuccin-frappe',
  'nord',
  'night-owl',
  'monokai',
  'material-theme',
  'material-theme-darker',
  'material-theme-ocean',
  'material-theme-palenight',
  'rose-pine',
  'rose-pine-moon',
  'ayu-dark',
  'ayu-mirage',
  'everforest-dark',
  'gruvbox-dark-hard',
  'gruvbox-dark-medium',
  'gruvbox-dark-soft',
  'kanagawa-wave',
  'kanagawa-dragon',
  'solarized-dark',
  'vitesse-dark',
  'vitesse-black',
  'vesper',
  'poimandres',
  'min-dark',
  'slack-dark',
  'synthwave-84',
  'aurora-x',
  'andromeeda',
  'horizon',
  'houston',
  'laserwave',
  'plastic',
  'red',
] as const;

export const LIGHT_CODE_THEMES = [
  'github-light-default',
  'github-light',
  'github-light-high-contrast',
  'pierre-light',
  'light-plus',
  'one-light',
  'catppuccin-latte',
  'rose-pine-dawn',
  'solarized-light',
  'everforest-light',
  'gruvbox-light-hard',
  'gruvbox-light-medium',
  'gruvbox-light-soft',
  'kanagawa-lotus',
  'ayu-light',
  'material-theme-lighter',
  'min-light',
  'vitesse-light',
  'night-owl-light',
  'snazzy-light',
  'slack-ochin',
  'horizon-bright',
] as const;

export const CODE_THEMES = [...DARK_CODE_THEMES, ...LIGHT_CODE_THEMES] as const;

export type CodeTheme = (typeof CODE_THEMES)[number];

export const DEFAULT_CODE_THEME: CodeTheme = 'github-dark-default';

/** Pierre picks its light or dark diff colours from this, so it has to match the syntax theme. */
export function codeThemeType(theme: string): 'light' | 'dark' {
  return (LIGHT_CODE_THEMES as readonly string[]).includes(theme) ? 'light' : 'dark';
}

export interface AppTheme {
  id: string;
  label: string;
  description: string;
  kind: 'light' | 'dark';
  /** Picking the app theme also switches to this code theme (it can be changed afterwards). */
  codeTheme: CodeTheme;
  /** The window background before the page paints; matches the theme's --c-bg. */
  background: string;
}

/** App themes; their colours are in renderer/themes.css under the same ids. */
export const APP_THEMES: AppTheme[] = [
  { id: 'github-dark', label: 'GitHub Dark', description: "github.com's dark theme.", kind: 'dark', codeTheme: 'github-dark-default', background: '#0d1117' },
  {
    id: 'github-dark-high-contrast',
    label: 'GitHub Dark High Contrast',
    description: 'The same, with white text, brighter borders and stronger colours.',
    kind: 'dark',
    codeTheme: 'github-dark-high-contrast',
    background: '#010409',
  },
  { id: 'slate', label: 'Slate', description: 'Slate blue with a cyan accent and pink buttons; code in the vivid Hydra colours.', kind: 'dark', codeTheme: 'hydra-plus-md', background: '#242533' },
  { id: 'github-light', label: 'GitHub Light', description: "github.com's light theme.", kind: 'light', codeTheme: 'github-light-default', background: '#ffffff' },
];

export const DEFAULT_APP_THEME = 'github-dark';

export function appTheme(id: string | undefined): AppTheme {
  return APP_THEMES.find((t) => t.id === id) ?? APP_THEMES[0]!;
}
