import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { asks as allAsks, CLAUDE_APPS, modelChoice, modelLabel, modelMenuItems, requestLabel, type Ask } from '../../../shared/agents';
import type { ClaudeModel, ClaudeView, Exchange, PendingRequest, PrSnapshot } from '../../../shared/model';
import { api, errorText } from '../../api';
import { Badge, Button, cx, ErrorBox, Icon, MarkdownText, Spinner } from '../../components/ui';
import { ASK_STATUS } from '../../diff/AskCard';
import { askClaude, loadClaudeModels, useClaudeSettings } from '../../state/claude';
import { useClaudeView } from '../../state/sessions';
import { focusFile, usePrUi } from '../../state/ui';

/** How long Claude worked: "42s", "3m 5s". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Milliseconds from `from` to `to`, or to now (kept current) while `live`; null without the times. */
function useElapsed(from: string | null, to: string | null, live: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  if (!from) return null;
  const end = live ? now : to ? new Date(to).getTime() : null;
  return end === null ? null : end - new Date(from).getTime();
}

/**
 * Your message, on the right in a bubble as in Claude Desktop: the lines it's about (a link to them), what you asked,
 * and under it how it stands while it's on its way.
 */
function YourMessage({ snapshot, ask, highlighted, below }: { snapshot: PrSnapshot; ask: Ask; highlighted: boolean; below?: ReactNode }) {
  const target = ask.request.kind === 'lines' ? ask.request.target : null;
  const prompt = ask.request.prompt.trim();
  return (
    <div className="self-end max-w-[88%] min-w-0 flex flex-col items-end gap-1">
      <div className={cx('min-w-0 max-w-full flex flex-col gap-1 px-3 py-2 rounded-[12px] rounded-br-[4px] bg-raised border transition-colors', highlighted ? 'border-accent' : 'border-line-2')}>
        {target && (
          // To the asked lines: their marker if it's still shown, else the file.
          <button
            type="button"
            title={`Go to ${requestLabel(ask.request)}`}
            onClick={() => focusFile(snapshot.key, target.path, null, `ask-${ask.id}`)}
            className="flex items-center gap-1 max-w-full min-w-0 text-[11.5px] font-mono text-link hover:underline cursor-pointer"
          >
            <Icon name="external" size={11} className="flex-none" />
            <span className="truncate">{requestLabel(ask.request, { fileName: true })}</span>
          </button>
        )}
        {prompt && <span className="text-[13px] text-fg whitespace-pre-wrap break-words">{prompt}</span>}
      </div>
      {below && <span className="flex flex-wrap items-center justify-end gap-2 text-[11.5px] text-muted">{below}</span>}
    </div>
  );
}

interface Choice {
  label: string;
  /** A line under the label: what choosing it does. */
  detail?: string;
  disabled?: boolean;
  /** Why it can't be chosen now. */
  disabledWhy?: string;
  choose(): void;
}

/**
 * A question with its choices, as Claude Desktop asks one: a card with the question, and a numbered row per choice.
 * While `keys` is on, 1, 2… choose too (not while you type in a text field).
 */
function ChoiceCard({ question, choices, note, keys }: { question: string; choices: Choice[]; note?: string; keys: boolean }) {
  const latest = useRef(choices);
  latest.current = choices;
  useEffect(() => {
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || el?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const choice = /^[1-9]$/.test(e.key) ? latest.current[Number(e.key) - 1] : undefined;
      if (!choice || choice.disabled) return;
      e.preventDefault();
      choice.choose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keys]);
  return (
    <div role="group" aria-label={question} className="flex flex-col rounded-[12px] border border-line-2 bg-raised overflow-hidden font-sans">
      <span className="px-3.5 pt-3 pb-2.5 text-[13px] font-semibold text-strong">{question}</span>
      {choices.map((c, i) => (
        <button
          key={c.label}
          type="button"
          aria-label={c.label}
          disabled={c.disabled}
          title={c.disabled ? c.disabledWhy : undefined}
          onClick={c.choose}
          className="group flex items-center gap-3 px-3.5 py-2.5 border-t border-line text-left hover:bg-raised-2 disabled:opacity-50 disabled:hover:bg-transparent cursor-pointer disabled:cursor-default"
        >
          <span aria-hidden="true" className={cx('grid place-items-center w-5 h-5 flex-none rounded-md text-[11px] font-semibold', i === 0 ? 'bg-accent text-ink' : 'bg-chip text-soft')}>
            {i + 1}
          </span>
          <span className="flex-1 min-w-0 flex flex-col">
            <span className="text-[13px] font-medium text-fg">{c.label}</span>
            {c.detail && <span className="text-[11.5px] text-muted truncate">{c.detail}</span>}
          </span>
          <span aria-hidden="true" className="text-muted opacity-0 group-hover:opacity-100 group-disabled:opacity-0">
            <Icon name="chevron" size={12} rotate={-90} />
          </span>
        </button>
      ))}
      {note && <span className="px-3.5 py-2 border-t border-line text-[11.5px] text-muted">{note}</span>}
    </div>
  );
}

/**
 * The choices Claude offered after its latest answer (offer_choices): one sends its prompt back as your next question
 * (about the same lines, for a line question), one without a prompt ("No") just puts them away.
 */
function OfferChoices({ snapshot, exchange, keys }: { snapshot: PrSnapshot; exchange: Exchange; keys: boolean }) {
  const key = snapshot.key;
  const offer = exchange.offer!;
  const choose = (prompt: string | null) => {
    if (prompt === null) return void api.dismissClaudeOffer(key, exchange.id);
    const lines = exchange.request.kind === 'lines' ? exchange.request.target : null;
    void askClaude(key, { kind: lines ? 'lines' : 'prompt', prompt, target: lines });
  };
  return (
    <ChoiceCard
      question={offer.question}
      keys={keys}
      choices={offer.choices.map((c) => ({ label: c.label, detail: c.prompt ? `Sends “${c.prompt}”` : undefined, choose: () => choose(c.prompt) }))}
    />
  );
}

/**
 * A question in the session and Claude's answer: your message on the right, then Claude's on the left without a box,
 * as in Claude Desktop: what it did, its reply, the comments it added, what it offers next, and how long it worked.
 */
function ExchangeView({ snapshot, view, exchange, ask, highlighted, shown }: { snapshot: PrSnapshot; view: ClaudeView; exchange: Exchange; ask: Ask; highlighted: boolean; shown: boolean }) {
  const key = snapshot.key;
  const [showActivity, setShowActivity] = useState(false);
  const live = ask.status === 'answering';
  const elapsed = useElapsed(exchange.at, exchange.endedAt, live);
  const comments = snapshot.drafts.filter((d) => exchange.draftIds.includes(d.id));
  // Comments it added that you haven't edited (an edited one is yours, and "Delete them" leaves it).
  const untouched = comments.filter((d) => d.origin !== undefined);
  // Its offer stands until it's answered: by a choice, by anything asked since, or by "No".
  const offering = exchange.offer !== null && exchange.done && view.exchanges.at(-1)?.id === exchange.id && view.pending.length === 0 && !view.dismissedOffers.includes(exchange.id);
  return (
    <div id={`conversation-${ask.id}`} className="flex flex-col gap-4">
      <YourMessage
        snapshot={snapshot}
        ask={ask}
        highlighted={highlighted}
        below={
          exchange.asked === 'elsewhere' && <span title="Asked in Claude Desktop or Claude Code, in this pull request’s session. PR Review shows the session as it is.">In Claude Desktop or Claude Code</span>
        }
      />
      <div className="flex flex-col gap-1.5 min-w-0 pr-2">
        {exchange.activity.length > 0 && (
          <button
            type="button"
            onClick={() => setShowActivity(!showActivity)}
            title={!showActivity && live ? exchange.activity.at(-1) : undefined}
            className="flex items-center gap-1 max-w-full min-w-0 text-left text-[11.5px] text-muted hover:text-fg cursor-pointer"
          >
            <Icon name="chevron" size={10} rotate={showActivity ? 0 : -90} />
            <span className="flex-none">
              {showActivity ? 'Hide' : 'Show'} what it did ({exchange.activity.length})
            </span>
            {/* The latest step on one line; a long file path is cut, the tooltip has all of it. */}
            {!showActivity && live && <span className="min-w-0 truncate">· {exchange.activity.at(-1)}</span>}
          </button>
        )}
        {showActivity && (
          <ul className="flex flex-col gap-0.5 pl-4 text-[11.5px] text-muted font-mono">
            {exchange.activity.map((a, i) => (
              <li key={i} className="truncate" title={a}>
                {a}
              </li>
            ))}
          </ul>
        )}
        {exchange.reply && <MarkdownText text={exchange.reply} className="text-comment text-fg break-words" />}
        {comments.length > 0 && (
          <span className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted">
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
              <button
                type="button"
                onClick={() =>
                  void api.deleteDrafts(
                    key,
                    untouched.map((d) => d.id),
                  )
                }
                className="text-muted hover:text-del cursor-pointer"
              >
                Delete {untouched.length === 1 ? 'it' : 'them'}
              </button>
            )}
          </span>
        )}
        {offering && <OfferChoices snapshot={snapshot} exchange={exchange} keys={shown} />}
        <span className="flex items-center gap-2 text-[11.5px] text-muted">
          {live && <Spinner />}
          <span>
            {live ? 'Answering' : ask.status === 'stopped' ? 'Stopped' : 'Worked'}
            {elapsed !== null ? ` ${live || ask.status === 'stopped' ? '· ' : 'for '}${duration(elapsed)}` : ''}
          </span>
          {live && view.busy === 'app' && (
            <Button size="sm" variant="ghost" onClick={() => void api.stopClaude(key)}>
              Stop
            </Button>
          )}
        </span>
      </div>
    </div>
  );
}

/** A question on its way to the session: your message, and under it whether it waits, was sent, or wasn't (with Retry). */
function PendingView({ snapshot, pending, ask, highlighted }: { snapshot: PrSnapshot; pending: PendingRequest; ask: Ask; highlighted: boolean }) {
  const key = snapshot.key;
  const status = ASK_STATUS[ask.status];
  return (
    <div id={`conversation-${ask.id}`} className="flex flex-col gap-3">
      <YourMessage
        snapshot={snapshot}
        ask={ask}
        highlighted={highlighted}
        below={
          <>
            {pending.state !== 'sent' && <Badge tone={status.tone}>{status.label}</Badge>}
            {pending.state === 'failed' && (
              <Button size="sm" variant="ghost" onClick={() => void api.retryClaudeRequest(key, pending.id)}>
                Retry
              </Button>
            )}
            {pending.state !== 'sent' && (
              <Button size="sm" variant="ghost" onClick={() => void api.cancelClaudeRequest(key, pending.id)}>
                Cancel
              </Button>
            )}
          </>
        }
      />
      {pending.state === 'sent' && (
        <span className="flex items-center gap-2 text-[11.5px] text-muted">
          <Spinner />
          Claude is reading it…
        </span>
      )}
      {pending.error && <ErrorBox message={pending.error} />}
    </div>
  );
}

/** Who has the session now, when it isn't the app and nothing needs deciding: who is answering, or what a question waits for. */
function statusLine(view: ClaudeView): string | null {
  if (view.waitingFor === 'desktop') return 'Waiting for Claude Desktop to finish answering in this session; your question goes next.';
  if (view.waitingFor === 'terminal') return null;
  if (view.busy === 'desktop' || view.busy === 'terminal') return `Claude is answering in ${CLAUDE_APPS[view.busy].name}.`;
  return null;
}

/**
 * Claude Code in a terminal has the session, so a question can't go in without closing it there: OK does that and
 * sends, Cancel drops the question, and a new question replaces it (see `PrClaude.ask`).
 */
function TakeSessionBox({ view, run, keyOf, keys }: { view: ClaudeView; run(action: () => Promise<void>): void; keyOf: string; keys: boolean }) {
  const waiting = view.pending.filter((p) => p.state === 'waiting');
  if (view.waitingFor !== 'terminal' || waiting.length === 0) return null;
  const answering = view.busy === 'terminal';
  return (
    <ChoiceCard
      question="Claude Code has this pull request’s session open in a terminal. Close it there and send your question?"
      keys={keys}
      note={answering ? 'Claude is answering there: OK once it’s done. A new question replaces this one.' : 'A new question replaces this one.'}
      choices={[
        {
          label: 'OK',
          detail: 'Claude Code stops in the terminal (claude --resume picks the session up again), and your question goes',
          disabled: answering,
          disabledWhy: 'Claude is answering there: OK once it’s done',
          choose: () => run(() => api.takeClaudeSession(keyOf)),
        },
        { label: 'Cancel', detail: 'Your question isn’t sent', choose: () => run(async () => void (await Promise.all(waiting.map((p) => api.cancelClaudeRequest(keyOf, p.id))))) },
      ]}
    />
  );
}

/**
 * The conversation's model and effort, under the box as Claude Desktop shows them ("Opus 5.5  Extra"): the models your
 * Claude Code offers. A choice holds for this pull request's next questions; Settings › Claude has the default.
 */
function ModelPicker({ prKey, view, onError }: { prKey: string; view: ClaudeView | undefined; onError(message: string): void }) {
  const settings = useClaudeSettings();
  const [models, setModels] = useState<ClaudeModel[] | null>(null);
  useEffect(() => void loadClaudeModels().then((list) => setModels(list.models)), []);
  const own = view?.modelChoice ?? null;
  const current = own ?? { model: settings.model, effort: settings.effort };
  const label = models ? modelLabel(models, current) : null;
  const open = async () => {
    const list = models ?? (await loadClaudeModels()).models;
    const choice = modelChoice(list, current, await api.contextMenu(modelMenuItems(list, current, own === null)));
    if (choice) await api.chooseClaudeModel(prKey, choice === 'default' ? null : choice).catch((err: unknown) => onError(errorText(err)));
  };
  return (
    <button
      type="button"
      aria-haspopup="menu"
      aria-label="Model and effort"
      title={`The model and effort for this pull request’s next questions${own ? '' : ' (the default from Settings › Claude)'}`}
      onClick={() => void open()}
      className="flex items-baseline gap-1.5 min-w-0 h-6 px-2 rounded-md text-[12px] hover:bg-raised cursor-pointer"
    >
      <span className="text-fg truncate">{label?.model ?? 'Model'}</span>
      {label?.effort && <span className="text-muted flex-none">{label.effort}</span>}
    </button>
  );
}

/**
 * The side panel's conversation with Claude (⇧⌘A): the PR's Claude Code session as it is, whether you asked here, in
 * Claude Desktop or in Claude Code, and a box for new questions. Nothing is kept here: it's read from the session.
 * `shown`: it's on screen (it stays mounted while the panel shows the comments).
 */
export function ClaudeConversation({ snapshot, shown }: { snapshot: PrSnapshot; shown: boolean }) {
  const key = snapshot.key;
  const view = useClaudeView(key);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const last = view?.exchanges.at(-1);
  // The box grows with what you type, like Claude Desktop's (up to its max height, then it scrolls).
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  // Follow the conversation as it grows, like a chat, and show the latest when the tab comes back.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && shown) el.scrollTop = el.scrollHeight;
  }, [shown, view?.exchanges.length, view?.pending.length, last?.reply, last?.activity.length]);
  // "Show in conversation" on a line: bring that question into view and mark it for a moment.
  const focusAsk = usePrUi(key).focusAsk;
  const [highlighted, setHighlighted] = useState<string | null>(null);
  useEffect(() => {
    if (!focusAsk) return;
    list.current?.querySelector(`#conversation-${CSS.escape(focusAsk.id)}`)?.scrollIntoView({ block: 'center' });
    setHighlighted(focusAsk.id);
    const timer = setTimeout(() => setHighlighted(null), 2000);
    return () => clearTimeout(timer);
  }, [focusAsk]);

  const send = async () => {
    if (!text.trim()) return;
    await askClaude(key, { kind: 'prompt', prompt: text, target: null });
    setText('');
  };
  const run = (action: () => Promise<void>) => {
    setError(null);
    action().catch((err: unknown) => setError(errorText(err)));
  };
  const askList = view ? allAsks(view) : [];
  const status = view ? statusLine(view) : null;

  return (
    <>
      <div ref={list} className="flex-1 min-h-0 overflow-y-auto px-3 py-4 flex flex-col gap-8">
        {askList.length === 0 && (
          <div className="text-[12.5px] text-muted leading-relaxed">
            This pull request gets one Claude Code session: questions on a line (“Ask Claude” in a comment) and what you type below go into it, and it opens in Claude Desktop or Claude Code too
            (the Claude button’s menu). What you ask there shows here as well. Comments Claude writes go into your review on their lines, as drafts you can edit or delete before you submit.
          </div>
        )}
        {view &&
          askList.map((a) => {
            const exchange = view.exchanges.find((e) => e.id === a.id);
            const pending = view.pending.find((p) => p.id === a.id);
            if (exchange) return <ExchangeView key={a.id} snapshot={snapshot} view={view} exchange={exchange} ask={a} highlighted={highlighted === a.id} shown={shown} />;
            return pending ? <PendingView key={a.id} snapshot={snapshot} pending={pending} ask={a} highlighted={highlighted === a.id} /> : null;
          })}
      </div>
      {(error ?? view?.error) && (
        <div className="px-3 pb-2">
          <ErrorBox message={(error ?? view?.error)!} />
        </div>
      )}
      <div className="px-3 pt-2.5 pb-2 border-t border-line flex flex-col gap-1.5">
        {view && <TakeSessionBox view={view} run={run} keyOf={key} keys={shown} />}
        {status && <span className="text-[11.5px] text-muted">{status}</span>}
        <div className="flex items-end gap-1 rounded-[14px] border border-line-2 bg-card focus-within:border-accent pl-3 pr-1.5 py-1.5">
          <textarea
            ref={input}
            rows={2}
            aria-label="Ask Claude"
            value={text}
            onChange={(e) => setText(e.target.value)}
            // Enter sends and Shift+Enter starts a new line, as in Claude Desktop (not while an input method is composing).
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              void send();
            }}
            placeholder="Ask Claude about this pull request…"
            className="flex-1 min-w-0 resize-none bg-transparent outline-none text-[13px] leading-[1.45] py-1 max-h-[200px] overflow-y-auto"
          />
          <button
            type="button"
            aria-label="Send"
            title="Send (⏎) · ⇧⏎ for a new line"
            disabled={!text.trim()}
            onClick={() => void send()}
            className="grid place-items-center w-8 h-8 flex-none rounded-[9px] text-fg hover:bg-raised-2 disabled:text-faint disabled:hover:bg-transparent cursor-pointer disabled:cursor-default"
          >
            <Icon name="enter" size={16} />
          </button>
        </div>
        <span className="flex justify-end -mr-1">
          <ModelPicker prKey={key} view={view} onError={setError} />
        </span>
      </div>
    </>
  );
}
