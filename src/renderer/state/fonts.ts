import { create } from 'zustand';

export type FontSlot = 'ui' | 'code';
export type FontStatus = 'builtin' | 'loading' | 'loaded' | 'failed';

/** Bundled fonts, used while a Google font loads, when offline, or when the name isn't a Google font. */
const FALLBACK: Record<FontSlot, string> = {
  ui: "'Inter Variable', system-ui, sans-serif",
  code: "'JetBrains Mono Variable', ui-monospace, SFMono-Regular, monospace",
};
const CSS_VAR: Record<FontSlot, string> = { ui: '--font-sans', code: '--font-mono' };
const SAFE_NAME = /^[A-Za-z0-9 ]{1,60}$/;

export const useFontStatus = create<Record<FontSlot, FontStatus>>(() => ({ ui: 'builtin', code: 'builtin' }));

const applied: Record<FontSlot, string | null> = { ui: null, code: null };

function cssUrl(family: string, weights: boolean): string {
  const name = encodeURIComponent(family).replace(/%20/g, '+');
  // The css2 API serves whichever of these weights a family has; an unknown family answers 400.
  return `https://fonts.googleapis.com/css2?family=${name}${weights ? ':wght@400;500;600;700' : ''}&display=swap`;
}

function loadStylesheet(slot: FontSlot, href: string): Promise<boolean> {
  document.getElementById(`google-font-${slot}`)?.remove();
  return new Promise((resolve) => {
    const link = document.createElement('link');
    link.id = `google-font-${slot}`;
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = () => resolve(true);
    link.onerror = () => {
      link.remove();
      resolve(false);
    };
    document.head.append(link);
  });
}

/** Uses `family` from Google Fonts for the UI or code text; an empty name means the bundled font. */
export async function setFont(slot: FontSlot, rawFamily: string): Promise<void> {
  const family = rawFamily.trim();
  if (applied[slot] === family) return;
  applied[slot] = family;
  const root = document.documentElement.style;
  if (!family) {
    document.getElementById(`google-font-${slot}`)?.remove();
    root.setProperty(CSS_VAR[slot], FALLBACK[slot]);
    useFontStatus.setState({ [slot]: 'builtin' });
    return;
  }
  if (!SAFE_NAME.test(family)) {
    root.setProperty(CSS_VAR[slot], FALLBACK[slot]);
    useFontStatus.setState({ [slot]: 'failed' });
    return;
  }
  // The text switches as soon as the font arrives; until then (or if it never does) the fallback is used.
  root.setProperty(CSS_VAR[slot], `"${family}", ${FALLBACK[slot]}`);
  useFontStatus.setState({ [slot]: 'loading' });
  const ok = (await loadStylesheet(slot, cssUrl(family, true))) || (await loadStylesheet(slot, cssUrl(family, false)));
  if (applied[slot] !== family) return;
  const faces = ok ? await document.fonts.load(`400 16px "${family}"`).catch(() => []) : [];
  if (applied[slot] !== family) return;
  useFontStatus.setState({ [slot]: faces.length > 0 ? 'loaded' : 'failed' });
}

export const UI_FONT_SUGGESTIONS = ['Mona Sans', 'Hubot Sans', 'Inter', 'Geist', 'IBM Plex Sans', 'Roboto', 'Source Sans 3', 'Noto Sans', 'Open Sans', 'Work Sans', 'Manrope', 'Lato'];
export const CODE_FONT_SUGGESTIONS = ['JetBrains Mono', 'Fira Code', 'Source Code Pro', 'IBM Plex Mono', 'Geist Mono', 'Roboto Mono', 'Red Hat Mono', 'Martian Mono', 'Space Mono', 'Ubuntu Mono', 'Inconsolata'];
