import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_THEMES, appTheme, CODE_THEMES, codeThemeType } from '../../src/shared/themes';

const css = (file: string) => readFileSync(join(import.meta.dirname, '../../src/renderer', file), 'utf8');

/** The --c-* tokens each `[data-theme='id']` block of themes.css defines. */
function paletteTokens(): Map<string, Set<string>> {
  const blocks = new Map<string, Set<string>>();
  for (const m of css('themes.css').matchAll(/\[data-theme='([^']+)'\]\s*\{([^}]*)\}/g)) {
    blocks.set(m[1]!, new Set([...m[2]!.matchAll(/(--c-[\w-]+):/g)].map((t) => t[1]!)));
  }
  return blocks;
}

describe('app themes', () => {
  const blocks = paletteTokens();
  const used = new Set([...css('styles.css').matchAll(/var\((--c-[\w-]+)\)/g)].map((m) => m[1]!));

  it('every theme defines every palette token the styles use', () => {
    for (const theme of APP_THEMES) {
      const tokens = blocks.get(theme.id);
      expect(tokens, theme.id).toBeDefined();
      expect([...used].filter((t) => !tokens!.has(t)), theme.id).toEqual([]);
      expect(tokens, theme.id).toEqual(blocks.get('github-dark'));
    }
  });

  it('pairs each app theme with a code theme of the same kind', () => {
    for (const theme of APP_THEMES) {
      expect(CODE_THEMES).toContain(theme.codeTheme);
      expect(codeThemeType(theme.codeTheme), theme.id).toBe(theme.kind);
    }
  });

  it('falls back to GitHub Dark for an unknown id', () => {
    expect(appTheme('nope').id).toBe('github-dark');
    expect(appTheme(undefined).id).toBe('github-dark');
  });
});
