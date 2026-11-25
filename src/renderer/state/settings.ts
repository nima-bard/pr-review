import { useMemo } from 'react';
import { create } from 'zustand';
import type { Settings } from '../../shared/model';
import { appTheme, CODE_THEMES, codeThemeType, DEFAULT_APP_THEME, DEFAULT_CODE_THEME } from '../../shared/themes';
import { api } from '../api';
import { setFont } from './fonts';

export const DEFAULT_DIFF_TINT = 12;
export const DEFAULT_LINE_HEIGHT = 20;
export const DEFAULT_COMMENT_FONT_SIZE = 14;
export const DEFAULT_CODE_FONT_SIZE = 13;

interface SettingsState {
  appTheme: string;
  codeTheme: string;
  diffTint: number;
  diffLineHeight: number;
  commentFontSize: number;
  codeFontSize: number;
  uiFont: string;
  codeFont: string;
}

export const useAppSettings = create<SettingsState>(() => ({ appTheme: cachedAppTheme(), codeTheme: DEFAULT_CODE_THEME, diffTint: DEFAULT_DIFF_TINT, diffLineHeight: DEFAULT_LINE_HEIGHT, commentFontSize: DEFAULT_COMMENT_FONT_SIZE, codeFontSize: DEFAULT_CODE_FONT_SIZE, uiFont: 'Mona Sans', codeFont: 'JetBrains Mono' }));

const THEME_KEY = 'app-theme';

/** The theme from the last run, so the first paint already has it (settings arrive from the main process later). */
function cachedAppTheme(): string {
  try {
    return appTheme(localStorage.getItem(THEME_KEY) ?? DEFAULT_APP_THEME).id;
  } catch {
    return DEFAULT_APP_THEME;
  }
}

function setAppTheme(id: string): void {
  document.documentElement.dataset.theme = id;
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {
    // Only the first paint of the next start is affected.
  }
}

/** Run before the first render. */
export function applyCachedAppTheme(): void {
  document.documentElement.dataset.theme = cachedAppTheme();
}

export function applyAppSettings(s: Pick<Settings, 'appTheme' | 'codeTheme' | 'diffTint' | 'diffLineHeight' | 'commentFontSize' | 'codeFontSize' | 'uiFont' | 'codeFont'>): void {
  const uiFont = typeof s.uiFont === 'string' ? s.uiFont : 'Mona Sans';
  const codeFont = typeof s.codeFont === 'string' ? s.codeFont : 'JetBrains Mono';
  void setFont('ui', uiFont);
  void setFont('code', codeFont);
  const commentFontSize = Number.isFinite(s.commentFontSize) ? s.commentFontSize : DEFAULT_COMMENT_FONT_SIZE;
  const codeFontSize = Number.isFinite(s.codeFontSize) ? s.codeFontSize : DEFAULT_CODE_FONT_SIZE;
  document.documentElement.style.setProperty('--comment-font-size', `${commentFontSize}px`);
  document.documentElement.style.setProperty('--code-font-size', `${codeFontSize}px`);
  const theme = appTheme(s.appTheme).id;
  setAppTheme(theme);
  useAppSettings.setState({
    appTheme: theme,
    uiFont,
    codeFont,
    commentFontSize,
    codeFontSize,
    // A saved code theme that no longer exists falls back to the app theme's own.
    codeTheme: (CODE_THEMES as readonly string[]).includes(s.codeTheme) ? s.codeTheme : appTheme(theme).codeTheme,
    diffTint: Number.isFinite(s.diffTint) ? s.diffTint : DEFAULT_DIFF_TINT,
    diffLineHeight: Number.isFinite(s.diffLineHeight) ? s.diffLineHeight : DEFAULT_LINE_HEIGHT,
  });
}

export async function loadAppSettings(): Promise<void> {
  applyAppSettings(await api.getSettings());
}

/**
 * Pierre mixes 20% of the theme's add/remove colour into changed lines (15% in the gutter, 0.2 alpha for changed words);
 * `tint` scales all three; `fontSize`/`lineHeight` set the code size. Pierre puts `unsafeCSS` in its last cascade layer,
 * so these win over its defaults.
 */
export function diffAppearanceCSS(tint: number, lineHeight: number, fontSize: number): string {
  const t = Math.min(40, Math.max(0, tint));
  const alpha = (t / 100).toFixed(2);
  const size = Math.min(24, Math.max(10, fontSize));
  // Keep at least 4px of leading, so a large font with a small line height doesn't overlap.
  const height = Math.max(size + 4, Math.min(36, Math.max(14, lineHeight)));
  return `:host { --diffs-font-size: ${size}px; --diffs-line-height: ${height}px; }
[data-line], [data-no-newline] {
  --mix-dark: ${100 - t}%;
  --mix-light: ${100 - t}%;
  --diffs-bg-addition-emphasis: rgb(from var(--diffs-addition-base) r g b / ${alpha});
  --diffs-bg-deletion-emphasis: rgb(from var(--diffs-deletion-base) r g b / ${alpha});
}
[data-gutter-buffer], [data-column-number] { --mix-dark: ${100 - Math.round(t * 0.75)}%; --mix-light: ${100 - Math.round(t * 0.75)}%; }
::highlight(pr-search) { background-color: color-mix(in srgb, var(--c-warn) 38%, transparent); }
::highlight(pr-find) { background-color: color-mix(in srgb, var(--c-accent) 32%, transparent); }
::highlight(pr-find-current) { background-color: color-mix(in srgb, var(--c-warn) 75%, transparent); color: var(--c-ink); }`;
}

/** The Pierre options that come from Settings: syntax theme (and whether it is light or dark), changed-line tint and line height. */
export function useDiffAppearance(): { theme: string; themeType: 'light' | 'dark'; unsafeCSS: string } {
  const { codeTheme, diffTint, diffLineHeight, codeFontSize } = useAppSettings();
  return useMemo(
    () => ({ theme: codeTheme, themeType: codeThemeType(codeTheme), unsafeCSS: diffAppearanceCSS(diffTint, diffLineHeight, codeFontSize) }),
    [codeTheme, diffTint, diffLineHeight, codeFontSize],
  );
}
