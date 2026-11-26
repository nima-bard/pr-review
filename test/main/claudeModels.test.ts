import { describe, expect, it } from 'vitest';
import { STANDARD_MODELS, toClaudeModels } from '../../src/main/agents/claudeModels';

describe('toClaudeModels', () => {
  it('lists Claude Code’s models as its /model picker does, its default as the empty model, with their effort levels', () => {
    const models = toClaudeModels([
      { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', supportedEffortLevels: ['low', 'high', 'max'] },
      { value: 'claude-haiku-4-5', displayName: 'Haiku 4.5', description: 'Fastest' },
    ]);
    expect(models).toEqual([
      { value: '', name: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', efforts: ['low', 'high', 'max'] },
      { value: 'claude-haiku-4-5', name: 'Haiku 4.5', description: 'Fastest', efforts: [] },
    ]);
  });

  it('stands in with Opus 5.5, Fable 5.2 and Haiku 5.5 and the standard effort levels when the list can’t be read', () => {
    expect(STANDARD_MODELS.map((m) => m.value)).toEqual(['', 'claude-opus-5-5', 'claude-fable-5-2', 'claude-haiku-5-5']);
    expect(STANDARD_MODELS[1]?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});
