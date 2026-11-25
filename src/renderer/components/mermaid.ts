import type { Mermaid } from 'mermaid';

let loading: Promise<Mermaid> | null = null;
let initializedFor: boolean | null = null;
let seq = 0;

/** Mermaid is large, so it is only loaded the first time a diagram shows up; it is set up again when the theme turns light or dark. */
async function loadMermaid(light: boolean): Promise<Mermaid> {
  loading ??= import('mermaid').then(({ default: mermaid }) => mermaid);
  const mermaid = await loading;
  if (initializedFor !== light) {
    initializedFor = light;
    mermaid.initialize({
      startOnLoad: false,
      theme: light ? 'default' : 'dark',
      // Diagram text comes from PR authors: strict encodes HTML in labels and disables click handlers.
      securityLevel: 'strict',
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() || "'Inter Variable', system-ui, sans-serif",
    });
  }
  return mermaid;
}

/**
 * GitHub's GraphQL HTML wraps a ```mermaid block in `<section data-type="mermaid">` with the source in `data-plain`
 * (it draws the diagram later in the browser); its REST markdown renders it as highlighted code instead.
 */
function findBlocks(root: HTMLElement): { el: Element; code: string }[] {
  const blocks: { el: Element; code: string }[] = [];
  for (const section of root.querySelectorAll('section[data-type="mermaid"]')) {
    const code = section.querySelector('[data-plain]')?.getAttribute('data-plain') ?? section.querySelector('pre')?.textContent ?? '';
    blocks.push({ el: section, code });
  }
  for (const el of root.querySelectorAll('div.highlight-source-mermaid, pre[lang="mermaid"], pre:has(> code.language-mermaid)')) {
    if (el.closest('section[data-type="mermaid"]') || blocks.some((b) => b.el.contains(el))) continue;
    blocks.push({ el, code: el.textContent ?? '' });
  }
  return blocks.filter((b) => b.code.trim() !== '');
}

/** Replaces every mermaid block under `root` with the rendered diagram; a block that fails shows the error and its source. */
export async function renderMermaid(root: HTMLElement, light: boolean): Promise<void> {
  const blocks = findBlocks(root);
  if (blocks.length === 0) return;
  const mermaid = await loadMermaid(light);
  for (const { el, code } of blocks) {
    if (!el.isConnected) continue;
    const figure = document.createElement('div');
    try {
      const { svg } = await mermaid.render(`mermaid-${++seq}`, code);
      figure.className = 'mermaid-diagram';
      figure.innerHTML = svg;
    } catch (err) {
      figure.className = 'mermaid-error';
      const message = document.createElement('div');
      message.textContent = `Couldn't draw this Mermaid diagram: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
      const source = document.createElement('pre');
      source.textContent = code;
      figure.append(message, source);
    }
    el.replaceWith(figure);
  }
}
