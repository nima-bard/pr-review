import { useMemo } from 'react';
import type { Draft, PrSnapshot } from '../../shared/model';
import { splitSuggestions } from '../../shared/suggestions';
import { MarkdownText } from '../components/ui';
import { useFileContent } from './useFileDiff';

/** A ```suggestion block as github.com shows it: the commented lines as they are, then the replacement. */
function SuggestedChange({ snapshot, draft, lines }: { snapshot: PrSnapshot; draft: Draft; lines: string[] }) {
  // Suggestions change the new version; on the old side there is nothing to replace.
  const file = useFileContent(snapshot.key, snapshot.details.headRefOid, 'head', draft.side === 'RIGHT' ? draft.path : null);
  const start = draft.startLine ?? draft.line;
  const current = file && !file.missing ? file.contents.split('\n').slice(start - 1, draft.line) : null;
  // Long lines wrap (keeping their indentation) instead of scrolling sideways, so each row's colour covers all of it.
  const row = (kind: 'del' | 'add', text: string, i: number) => (
    <div key={`${kind}${i}`} className={kind === 'del' ? 'flex bg-del-soft' : 'flex bg-add-soft'}>
      <span aria-hidden="true" className={kind === 'del' ? 'w-5 flex-none text-center text-del select-none' : 'w-5 flex-none text-center text-add select-none'}>
        {kind === 'del' ? '−' : '+'}
      </span>
      <span className="min-w-0 pr-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{text || ' '}</span>
    </div>
  );
  return (
    <div className="my-2 rounded-md border border-line-2 overflow-hidden">
      <div className="px-2.5 py-1 text-[12px] font-semibold text-soft bg-raised-2 border-b border-line-2">Suggested change</div>
      <div className="font-mono text-code leading-[1.6] py-1">
        {current?.map((text, i) => row('del', text, i))}
        {lines.map((text, i) => row('add', text, i))}
        {lines.length === 0 && <div className="px-2.5 text-[12px] text-muted font-sans">Deletes the lines.</div>}
      </div>
    </div>
  );
}

/** A draft's text as it will read on GitHub: Markdown, with ```suggestion blocks shown as changes. */
export function CommentBody({ snapshot, draft }: { snapshot: PrSnapshot; draft: Draft }) {
  const parts = useMemo(() => splitSuggestions(draft.body), [draft.body]);
  return (
    <div className="min-w-0 flex-1 text-fg">
      {parts.map((p, i) => (p.kind === 'text' ? <MarkdownText key={i} text={p.text} /> : <SuggestedChange key={i} snapshot={snapshot} draft={draft} lines={p.lines} />))}
    </div>
  );
}
