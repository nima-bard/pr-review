import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { QuickAction } from '../../src/shared/model';
import { actionApplies, actionsFor, shellQuote } from '../../src/shared/quickActions';

const action = (over: Partial<QuickAction> = {}): QuickAction => ({ id: 'a', name: 'A', command: 'true', mode: 'background', scope: 'pr', repos: '', confirm: false, ...over });

describe('actionApplies', () => {
  it('applies everywhere without patterns', () => {
    expect(actionApplies(action(), 'acme/app')).toBe(true);
  });

  it('matches owner/repo and owner/*, ignoring case, separated by commas or spaces', () => {
    const a = action({ repos: 'Acme/*, other/tool  solo/one' });
    expect(actionApplies(a, 'acme/app')).toBe(true);
    expect(actionApplies(a, 'other/tool')).toBe(true);
    expect(actionApplies(a, 'solo/one')).toBe(true);
    expect(actionApplies(a, 'other/app')).toBe(false);
    expect(actionApplies(a, 'acmeish/app')).toBe(false);
  });
});

describe('actionsFor', () => {
  it('keeps the order and picks by scope and repository', () => {
    const list = [action({ id: '1' }), action({ id: '2', scope: 'file' }), action({ id: '3', repos: 'x/y' }), action({ id: '4' })];
    expect(actionsFor(list, 'acme/app', 'pr').map((a) => a.id)).toEqual(['1', '4']);
    expect(actionsFor(list, 'x/y', 'pr').map((a) => a.id)).toEqual(['1', '3', '4']);
    expect(actionsFor(list, 'acme/app', 'file').map((a) => a.id)).toEqual(['2']);
  });
});

describe('shellQuote', () => {
  it('makes any text one literal shell word', () => {
    for (const text of [`it's`, `"; rm -rf ~ #`, '$(whoami) `id` $HOME', 'line\nbreak', '']) {
      expect(execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(text)}`], { encoding: 'utf8' })).toBe(text);
    }
  });
});
