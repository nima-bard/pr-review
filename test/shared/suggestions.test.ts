import { describe, expect, it } from 'vitest';
import { splitSuggestions } from '../../src/shared/suggestions';

describe('splitSuggestions', () => {
  it('keeps a comment without suggestions as one piece of Markdown', () => {
    expect(splitSuggestions('Looks **good**.')).toEqual([{ kind: 'text', text: 'Looks **good**.' }]);
  });

  it('splits out a suggestion block with its replacement lines', () => {
    const body = 'Name both actions first:\n\n```suggestion\n    echo "Adds or removes access"\n    echo ""\n```\n\nThen the target.';
    expect(splitSuggestions(body)).toEqual([
      { kind: 'text', text: 'Name both actions first:\n\n' },
      { kind: 'suggestion', lines: ['    echo "Adds or removes access"', '    echo ""'] },
      { kind: 'text', text: '\n\nThen the target.' },
    ]);
  });

  it('reads an empty suggestion as deleting the lines', () => {
    expect(splitSuggestions('```suggestion\n```')).toEqual([{ kind: 'suggestion', lines: [] }]);
  });

  it('leaves other code blocks in the Markdown', () => {
    expect(splitSuggestions('```ts\nconst a = 1;\n```')).toEqual([{ kind: 'text', text: '```ts\nconst a = 1;\n```' }]);
  });
});
