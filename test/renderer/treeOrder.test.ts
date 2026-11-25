import { describe, expect, it } from 'vitest';
import { closestInTree, foldersOf, treeCompare } from '../../src/renderer/views/pr/treeOrder';

describe('treeCompare', () => {
  it('lists folders before files, then by name', () => {
    const paths = ['src/z.ts', 'README.md', 'src/lib/a.ts', 'src/a.ts', 'docs/x.md'];
    expect([...paths].sort(treeCompare)).toEqual(['docs/x.md', 'src/lib/a.ts', 'src/a.ts', 'src/z.ts', 'README.md']);
  });
});

describe('closestInTree', () => {
  const changed = ['api/routes.ts', 'api/server.ts', 'core/query/handler.ts', 'core/query/types.ts', 'web/app.ts'];

  it('returns the path itself when it is a candidate', () => {
    expect(closestInTree('core/query/types.ts', changed)).toBe('core/query/types.ts');
  });

  it('prefers a file in the same folder', () => {
    expect(closestInTree('core/query/parse.ts', changed)).toBe('core/query/handler.ts');
    expect(closestInTree('core/query/zeta.ts', changed)).toBe('core/query/types.ts');
  });

  it('prefers the neighbour in the deeper shared folder over the nearer-looking one', () => {
    // Folders come first, so this is listed between core/query/types.ts and web/app.ts; it shares "core" with the one above.
    expect(closestInTree('core/config.ts', changed)).toBe('core/query/types.ts');
    // Listed between api/server.ts and core/query/handler.ts; it shares "core" with the one below.
    expect(closestInTree('core/other/thing.ts', changed)).toBe('core/query/handler.ts');
  });

  it('takes the one above on a tie, and the only neighbour at either end', () => {
    expect(closestInTree('b/x.ts', changed)).toBe('api/server.ts');
    expect(closestInTree('aaa/x.ts', changed)).toBe('api/routes.ts');
    expect(closestInTree('zzz.ts', changed)).toBe('web/app.ts');
    expect(closestInTree('x.ts', [])).toBeNull();
  });
});

describe('foldersOf', () => {
  it('lists the containing folders outermost first', () => {
    expect(foldersOf('a/b/c.ts')).toEqual(['a', 'a/b']);
    expect(foldersOf('c.ts')).toEqual([]);
  });
});
