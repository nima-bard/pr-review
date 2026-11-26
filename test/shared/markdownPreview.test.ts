import { describe, expect, it } from 'vitest';
import { markdownPreview } from '../../src/shared/markdownPreview';

describe('markdownPreview', () => {
  it('gives the first line as text: no heading marks, emphasis or code ticks, and placeholders in code kept', () => {
    const body = '### `<lastModifiedOn2>` gets its value outside the Gherkin\n\n**Severity**: NICE TO FIX · **Confidence**: 70%';
    expect(markdownPreview(body)).toBe('<lastModifiedOn2> gets its value outside the Gherkin');
    expect(markdownPreview('**Severity**: _high_, see [the docs](https://x.test) and ~~old~~')).toBe('Severity: high, see the docs and old');
  });

  it('skips what isn’t text: code blocks and suggestions, HTML comments, layout tags, rules and empty lines', () => {
    expect(markdownPreview('```suggestion\nconst a = 1;\n```\nUse a constant.')).toBe('Use a constant.');
    expect(markdownPreview('<!-- claude-review -->\n\n---\n<details><summary>Why</summary>\nIt leaks.')).toBe('Why');
    expect(markdownPreview('> quoted\nreply')).toBe('quoted');
    expect(markdownPreview('- [ ] a task')).toBe('a task');
  });

  it('keeps underscores and asterisks inside words, and gives nothing for an empty comment', () => {
    expect(markdownPreview('snake_case_name and 2*3*4')).toBe('snake_case_name and 2*3*4');
    expect(markdownPreview('```\nonly code\n```')).toBe('');
  });
});
