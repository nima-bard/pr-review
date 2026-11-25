import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentTurn, PrSnapshot } from '../../../shared/model';
import { requestLabel } from '../../../shared/agents';
import { api, errorText } from '../../api';
import { Badge, Button, cx, ErrorBox, Icon, MarkdownText, Select, Spinner } from '../../components/ui';
import { askAgent, useAgentFor, useAgents } from '../../state/agents';
import { loadAgentSession, useAgentSession } from '../../state/sessions';
import { focusFile, updateUi, usePrUi } from '../../state/ui';
import { openSettings } from '../../state/tabs';

const STATUS: Record<AgentTurn['status'], { label: string; tone: 'muted' | 'info' | 'warn' | 'ok' | 'bad' }> = {
  queued: { label: 'Waiting', tone: 'muted' },
  running: { label: 'Working…', tone: 'info' },
  done: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  stopped: { label: 'Stopped', tone: 'muted' },
  'handed-off': { label: 'Sent', tone: 'info' },
};

/** "$0.04" for a turn's cost; under a cent shows as "<$0.01". */
const cost = (usd: number) => (usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`);

/** One request and its answer: what was asked, what the agent did, its reply, and the comments it added. */
export function TurnCard({ snapshot, turn, highlighted = false }: { snapshot: PrSnapshot; turn: AgentTurn; highlighted?: boolean }) {
  const key = snapshot.key;
  const [showActivity, setShowActivity] = useState(false);
  const live = turn.status === 'queued' || turn.status === 'running';
  const comments = snapshot.drafts.filter((d) => turn.draftIds.includes(d.id));
  // Comments it added that you haven't edited (an edited one is yours, and "Delete them" leaves it).
  const untouched = comments.filter((d) => d.origin !== undefined);
  const status = STATUS[turn.status];
  const target = turn.request.kind === 'lines' ? turn.request.target : null;
  return (
    <div
      id={`turn-${turn.id}`}
      className={cx('flex flex-col gap-1.5 px-3 py-2.5 rounded-[9px] bg-raised border font-sans transition-colors', highlighted ? 'border-accent' : 'border-line-2')}
    >
      <span className="flex items-center gap-2 min-w-0">
        <span className="text-[12px] font-semibold text-strong truncate" title={requestLabel(turn.request)}>
          {turn.agent} · {requestLabel(turn.request, { fileName: true })}
        </span>
        <span className="flex-1" />
        {target && (
          // To the asked lines: their marker if it's still shown, else the file.
          <Button size="sm" title={`Go to ${requestLabel(turn.request)}`} onClick={() => focusFile(key, target.path, null, `ask-${turn.id}`)}>
            <Icon name="external" size={12} />
            Go to line
          </Button>
        )}
        {turn.status === 'running' ? <Spinner /> : null}
        <Badge tone={status.tone}>{status.label}</Badge>
        {live && (
          <Button size="sm" variant="ghost" onClick={() => void api.stopAgentTurn(key, turn.id)}>
            {turn.status === 'queued' ? 'Cancel' : 'Stop'}
          </Button>
        )}
      </span>
      {turn.request.prompt.trim() && <span className="text-[12.5px] text-soft whitespace-pre-wrap line-clamp-4">{turn.request.prompt}</span>}
      {turn.activity.length > 0 && (
        <button
          type="button"
          onClick={() => setShowActivity(!showActivity)}
          title={!showActivity && live ? turn.activity.at(-1) : undefined}
          className="flex items-center gap-1 max-w-full min-w-0 text-left text-[11.5px] text-muted hover:text-fg cursor-pointer"
        >
          <Icon name="chevron" size={10} rotate={showActivity ? 0 : -90} />
          <span className="flex-none">
            {showActivity ? 'Hide' : 'Show'} what it did ({turn.activity.length})
          </span>
          {/* The latest step on one line; a long file path is cut, the tooltip has all of it. */}
          {!showActivity && live && <span className="min-w-0 truncate">· {turn.activity.at(-1)}</span>}
        </button>
      )}
      {showActivity && (
        <ul className="flex flex-col gap-0.5 pl-4 text-[11.5px] text-muted font-mono">
          {turn.activity.map((a, i) => (
            <li key={i} className="truncate" title={a}>
              {a}
            </li>
          ))}
        </ul>
      )}
      {turn.reply && <MarkdownText text={turn.reply} className="text-comment text-fg break-words" />}
      {turn.error && <ErrorBox message={turn.error} />}
      {(comments.length > 0 || turn.costUsd !== null) && (
        <span className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted">
          {comments.length > 0 && (
            <>
              <span>
                {comments.length} comment{comments.length === 1 ? '' : 's'} added to your review:
              </span>
              {comments.map((d) => (
                <Button key={d.id} size="sm" title={`Go to the comment on ${d.path}:${d.line}`} onClick={() => focusFile(key, d.path, null, `draft-${d.id}`)}>
                  <Icon name="comment" size={12} />
                  <span className="font-mono">
                    {d.path.split('/').at(-1)}:{d.line}
                  </span>
                </Button>
              ))}
              {untouched.length > 0 && (
                <button type="button" onClick={() => void api.deleteTurnDrafts(key, turn.id)} className="text-muted hover:text-del cursor-pointer">
                  Delete {untouched.length === 1 ? 'it' : 'them'}
                </button>
              )}
            </>
          )}
          <span className="flex-1" />
          {turn.costUsd !== null && <span title="What this request cost, as Claude Code reports it">{cost(turn.costUsd)}</span>}
        </span>
      )}
    </div>
  );
}

/** The PR's agent conversation (⇧⌘A): every request sent from the app and its answer, and a box for new requests. */
export function AgentPanel({ snapshot }: { snapshot: PrSnapshot }) {
  const key = snapshot.key;
  const agents = useAgents((s) => s.agents);
  const agent = useAgentFor(key);
  const session = useAgentSession(key);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const turns = session?.turns ?? [];
  const last = turns.at(-1);
  useEffect(() => {
    void loadAgentSession(key).catch(() => undefined);
  }, [key]);
  // Follow the conversation as it grows, like a chat.
  useLayoutEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, last?.reply, last?.activity.length]);
  // "Show in Agent panel" on a line: bring that request into view and mark it for a moment.
  const focusTurn = usePrUi(key).focusTurn;
  const [highlighted, setHighlighted] = useState<string | null>(null);
  useEffect(() => {
    if (!focusTurn) return;
    list.current?.querySelector(`#turn-${CSS.escape(focusTurn.id)}`)?.scrollIntoView({ block: 'center' });
    setHighlighted(focusTurn.id);
    const timer = setTimeout(() => setHighlighted(null), 2000);
    return () => clearTimeout(timer);
  }, [focusTurn]);

  const send = async () => {
    if (!text.trim()) return;
    await askAgent(key, { kind: 'prompt', prompt: text, target: null }, false);
    setText('');
  };
  const run = (action: () => Promise<void>) => {
    setError(null);
    action().catch((err: unknown) => setError(errorText(err)));
  };
  const busy = turns.some((t) => t.status === 'running');

  return (
    <aside aria-label="Agent" className="w-[420px] flex-none flex flex-col bg-side border-l border-line min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
        <h2 className="text-[13px] font-semibold text-strong">Agent</h2>
        {agents.length > 1 && agent ? (
          <Select surface="raised" aria-label="Agent for this pull request" value={agent.id} disabled={busy} onChange={(e) => run(() => api.setAgentConnector(key, e.target.value))} className="flex-1 min-w-0 [&_select]:h-7">
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        ) : (
          <span className="flex-1 text-[12px] text-muted truncate">{agent?.name}</span>
        )}
        <button type="button" aria-label="Close the Agent panel" onClick={() => updateUi(key, { showAgent: false })} className="grid place-items-center w-[26px] h-[26px] rounded-md text-muted hover:text-fg cursor-pointer">
          <Icon name="close" size={13} />
        </button>
      </div>
      {!agent ? (
        <div className="p-4 flex flex-col gap-3 text-[12.5px] text-fg">
          <span>No agent is set up. Set up Claude (or another agent) in Settings, then ask it about this pull request here.</span>
          <Button className="w-fit" onClick={() => openSettings('agents')}>
            Open Settings › Agents
          </Button>
        </div>
      ) : (
        <>
          <div ref={list} className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2.5">
            {turns.length === 0 && (
              <div className="text-[12.5px] text-muted leading-relaxed">
                Every request about this pull request goes to the same {agent.name} session: reviews, questions on a line (“Ask” in a comment), and what you type below. Comments it writes go into your review on their
                lines, as drafts you can edit or delete before you submit.
              </div>
            )}
            {turns.map((t) => (
              <TurnCard key={t.id} snapshot={snapshot} turn={t} highlighted={highlighted === t.id} />
            ))}
          </div>
          {error && (
            <div className="px-3 pb-2">
              <ErrorBox message={error} />
            </div>
          )}
          <div className="p-3 border-t border-line flex flex-col gap-2">
            <textarea
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
              }}
              placeholder={`Ask ${agent.name} about this pull request…`}
              className="resize-y px-2.5 py-2 rounded-[7px] bg-card border border-line-2 focus:border-accent outline-none text-[13px]"
            />
            <span className="flex items-center gap-2">
              {agent.kind === 'claude-code' && session?.started && (
                <Button
                  size="sm"
                  disabled={busy}
                  title={`This pull request's conversation in Claude Desktop, always the same session (named “PR #${snapshot.ref.number}”). Continue it there or here, one at a time.`}
                  onClick={() => run(() => api.openAgentInDesktop(key))}
                >
                  Open in Claude Desktop
                </Button>
              )}
              <span className={cx('flex-1 text-[11.5px] text-muted', turns.some((t) => t.status === 'queued') ? '' : 'invisible')}>Requests run one at a time.</span>
              <Button size="sm" variant="primary" disabled={!text.trim()} onClick={() => void send()}>
                Send
              </Button>
            </span>
          </div>
        </>
      )}
    </aside>
  );
}
