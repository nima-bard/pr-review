import { useEffect, useRef, useState } from 'react';
import type { Draft, PrSnapshot } from '../../shared/model';
import { api, errorText } from '../api';
import { Avatar, Badge, Button, cx, Segmented } from '../components/ui';
import { askPrefix } from '../../shared/agents';
import { askAgent, useAgentFor } from '../state/agents';
import { requestComposer, updateUi, usePrUi } from '../state/ui';
import { readUnsent, unsentKey, writeUnsent, type ComposerTarget } from '../state/unsent';

function newDraftId(): string {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Text typed into a comment editor but never added to the review: it stays on this machine and is never sent. */
export interface UnsentComment {
  storageKey: string;
  text: string;
  /** Where to reopen it; an edit of an existing draft carries its `draftId`. */
  target: ComposerTarget;
}

/** Unfinished comments for a PR, so Submit review can say they aren't part of it. */
export function unsentComments(prKey: string, drafts: readonly Draft[]): UnsentComment[] {
  const prefix = `composer:${prKey}:`;
  const out: UnsentComment[] = [];
  let keys: string[] = [];
  try {
    keys = Object.keys(localStorage).filter((k) => k.startsWith(prefix));
  } catch {
    return [];
  }
  for (const storageKey of keys) {
    const text = readUnsent(storageKey) ?? '';
    if (!text.trim()) continue;
    const rest = storageKey.slice(prefix.length);
    const draft = drafts.find((d) => d.id === rest);
    if (draft) {
      out.push({ storageKey, text, target: { path: draft.path, side: draft.side, startLine: draft.startLine ?? draft.line, endLine: draft.line, draftId: draft.id, body: draft.body } });
      continue;
    }
    const m = /^(.*):(LEFT|RIGHT):(\d+)-(\d+)$/.exec(rest);
    if (m) out.push({ storageKey, text, target: { path: m[1]!, side: m[2] as ComposerTarget['side'], startLine: Number(m[3]), endLine: Number(m[4]) } });
  }
  return out.sort((a, b) => a.target.path.localeCompare(b.target.path) || a.target.endLine - b.target.endLine);
}

export function discardUnsent(storageKey: string): void {
  writeUnsent(storageKey, null);
}

export function Composer({ snapshot, target }: { snapshot: PrSnapshot; target: ComposerTarget }) {
  const storeKey = unsentKey(snapshot.key, target);
  const [body, setBody] = useState(() => readUnsent(storeKey) ?? target.body ?? '');
  const [error, setError] = useState<string | null>(null);
  const prompt = usePrUi(snapshot.key).composerPrompt;
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => writeUnsent(storeKey, body === (target.body ?? '') ? null : body), [storeKey, body, target.body]);
  // When something tries to close or replace this editor, bring it (and the question) into view.
  useEffect(() => {
    if (prompt) root.current?.scrollIntoView({ block: 'nearest' });
  }, [prompt]);
  const isDraftEdit = target.draftId !== undefined;
  const agent = useAgentFor(snapshot.key);
  // Comment, or ask the PR's agent about these lines; typing "/ask " or "/claude " at the start switches to asking.
  const [mode, setMode] = useState<'comment' | 'ask'>('comment');
  const asking = mode === 'ask' && agent !== undefined && !isDraftEdit;
  const onText = (text: string) => {
    const asked = agent && !isDraftEdit ? askPrefix(text) : null;
    if (asked !== null && /^\s*\/(ask|claude)\s/i.test(text)) {
      setMode('ask');
      setBody(asked);
    } else setBody(text);
  };
  const ask = async () => {
    if (!body.trim()) return;
    await askAgent(snapshot.key, { kind: 'lines', prompt: body, target: { path: target.path, side: target.side, startLine: target.startLine, endLine: target.endLine } }, false);
    finish();
  };
  const send = () => void (asking ? ask() : save());
  /** Ends this editor and opens whatever was waiting (another line, or nothing). */
  const finish = () => {
    writeUnsent(storeKey, null);
    updateUi(snapshot.key, { composer: prompt?.next ?? null, composerPrompt: null });
  };
  const save = async () => {
    if (!body.trim()) return;
    const existing = target.draftId ? snapshot.drafts.find((d) => d.id === target.draftId) : undefined;
    const draft: Draft = {
      id: target.draftId ?? newDraftId(),
      path: target.path,
      subject: 'line',
      side: target.side,
      line: target.endLine,
      body,
      headOid: snapshot.details.headRefOid,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      ...(target.startLine !== target.endLine ? { startLine: target.startLine } : {}),
      // An agent's suggestion keeps who wrote it; saving your edit accepts it (main does that).
      ...(existing?.origin ? { origin: existing.origin } : {}),
    };
    try {
      await api.saveDraft(snapshot.key, draft);
      finish();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const range = target.startLine === target.endLine ? `line ${target.endLine}` : `lines ${target.startLine}–${target.endLine}`;
  return (
    <div ref={root} className="max-w-[680px] rounded-[9px] bg-raised border border-accent overflow-hidden font-sans text-comment">
      <div className={cx('flex items-center gap-2 px-3 border-b border-line-2 text-muted text-[12px]', agent && !isDraftEdit ? 'py-1.5' : 'py-2')}>
        <span className="flex-1">
          {asking ? 'Ask about' : 'New comment on'} {target.side === 'LEFT' ? 'old ' : ''}
          {range}
        </span>
        {agent && !isDraftEdit && (
          <Segmented<'comment' | 'ask'>
            label="Comment or ask"
            size="sm"
            value={asking ? 'ask' : 'comment'}
            onChange={setMode}
            options={[
              { value: 'comment', label: 'Comment' },
              { value: 'ask', label: `Ask ${agent.name}` },
            ]}
          />
        )}
      </div>
      <div className="p-3 flex flex-col gap-2">
        <textarea
          ref={box}
          autoFocus
          rows={4}
          value={body}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
            if (e.key === 'Escape') {
              e.stopPropagation();
              requestComposer(snapshot.key, null);
            }
          }}
          placeholder={
            asking
              ? `Ask ${agent.name} about these lines, e.g. “Does this break our guidelines? If so, write a comment here.”`
              : `Leave a comment (Markdown, \`\`\`suggestion blocks supported)${agent && !isDraftEdit ? '; start with /ask to ask instead' : ''}`
          }
          className="resize-y px-2.5 py-2 rounded-[7px] bg-side border border-line-2 focus:border-accent outline-none"
        />
        {error && <div className="text-del text-[12px]">{error}</div>}
        {prompt ? (
          <div role="alertdialog" aria-label="Unsaved comment" className="flex flex-wrap items-center gap-2 px-3 py-2 -mx-3 -mb-3 bg-warn-bg border-t border-warn-line">
            <span className="text-warn text-[12.5px] font-semibold">{isDraftEdit ? 'Your changes to this draft aren’t saved.' : 'This comment isn’t in your review yet.'}</span>
            <span className="flex-1" />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                updateUi(snapshot.key, { composerPrompt: null });
                box.current?.focus();
              }}
            >
              Keep editing
            </Button>
            <Button size="sm" variant="danger" onClick={finish}>
              {isDraftEdit ? 'Discard changes' : 'Discard'}
            </Button>
            <Button size="sm" variant="primary" disabled={!body.trim()} onClick={() => void save()}>
              {isDraftEdit ? 'Save draft' : 'Add review comment'}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-[11.5px] text-muted">
              {asking ? `⌘⏎ sends it to ${agent.name}; a comment it writes arrives here as a suggestion` : `⌘⏎ or “${isDraftEdit ? 'Save draft' : 'Add review comment'}” puts it in your review`}
            </span>
            <span className="flex-1" />
            <Button size="sm" variant="ghost" onClick={finish}>
              Discard
            </Button>
            <Button size="sm" variant="primary" disabled={!body.trim()} onClick={send}>
              {asking ? `Ask ${agent.name}` : isDraftEdit ? 'Save draft' : 'Add review comment'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function DraftCard({ snapshot, draft }: { snapshot: PrSnapshot; draft: Draft }) {
  const range = draft.startLine !== undefined ? `Lines ${draft.startLine}–${draft.line}` : `Line ${draft.line}`;
  const suggested = draft.origin !== undefined && draft.origin.acceptedAt === null;
  const edit = () => requestComposer(snapshot.key, { path: draft.path, side: draft.side, startLine: draft.startLine ?? draft.line, endLine: draft.line, draftId: draft.id, body: draft.body });
  return (
    <div className={cx('max-w-[680px] rounded-[9px] bg-raised border overflow-hidden font-sans text-comment', suggested ? 'border-warn-line' : 'border-info-line')}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line-2">
        <span className="font-semibold">{range}</span>
        {suggested ? (
          <Badge tone="warn" className="max-w-[260px] truncate">
            Suggested by {draft.origin!.agent} · not in your review until you accept it
          </Badge>
        ) : (
          <Badge tone="info">{draft.origin ? `Draft · from ${draft.origin.agent}` : 'Draft · not posted yet'}</Badge>
        )}
        {draft.unplaceable && <Badge tone="bad">Line changed in a new push · move or delete</Badge>}
        <span className="flex-1" />
        {suggested && (
          <Button size="sm" variant="primary" onClick={() => void api.acceptDrafts(snapshot.key, [draft.id])}>
            Accept
          </Button>
        )}
        <Button size="sm" onClick={edit} title={suggested ? 'Saving your edit accepts it' : undefined}>
          Edit
        </Button>
        <Button size="sm" onClick={() => void api.deleteDraft(snapshot.key, draft.id)}>
          {suggested ? 'Dismiss' : 'Delete'}
        </Button>
      </div>
      <div className="flex gap-2.5 px-3 py-2.5">
        {draft.origin ? <AgentAvatar name={draft.origin.agent} /> : <Avatar login={snapshot.viewer} size={26} />}
        <div className="min-w-0 flex-1 whitespace-pre-wrap text-fg">{draft.body}</div>
      </div>
    </div>
  );
}

/** The agent's initial in a circle, where your avatar would be. */
export function AgentAvatar({ name, size = 26 }: { name: string; size?: number }) {
  return (
    <span aria-hidden className="grid shrink-0 place-items-center rounded-full bg-warn-bg text-warn font-bold" style={{ width: size, height: size, fontSize: size * 0.46 }}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
