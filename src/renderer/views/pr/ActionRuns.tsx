import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ActionRun } from '../../../shared/model';
import { api } from '../../api';
import { Button, cx, Icon, Spinner } from '../../components/ui';
import { runQuickAction, useQuickActions } from '../../state/quickActions';
import { dismissRun, loadRuns, useSessions } from '../../state/sessions';
import { updateUi } from '../../state/ui';

const NO_RUNS: ActionRun[] = [];

/** Terminal output as text: colour codes and other escape sequences dropped, a line rewritten with \r (progress) as its last state. */
export function plainOutput(output: string): string {
  return output
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]/g, '')
    .split('\n')
    .map((line) => line.replace(/\r+$/, '').split('\r').at(-1) ?? '')
    .join('\n');
}

function useRuns(prKey: string): ActionRun[] {
  return useSessions((s) => s.runs[prKey] ?? NO_RUNS);
}

/** "0:42", "12:03": how long a run has taken, kept current while it runs. */
function Elapsed({ run }: { run: ActionRun }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (run.endedAt) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [run.endedAt]);
  const ms = (run.endedAt ? new Date(run.endedAt).getTime() : Date.now()) - new Date(run.startedAt).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  return <span className="tabular-nums">{`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`}</span>;
}

const MARK: Record<ActionRun['status'], { mark: string; className: string; label: string }> = {
  running: { mark: '', className: '', label: 'running' },
  succeeded: { mark: '✓', className: 'text-add', label: 'finished' },
  failed: { mark: '✕', className: 'text-del', label: 'failed' },
  stopped: { mark: '■', className: 'text-muted', label: 'stopped' },
};

/** The status bar's view of background quick actions: what's running (with its time), or how the last one ended. */
export function RunsIndicator({ prKey }: { prKey: string }) {
  const runs = useRuns(prKey);
  useEffect(() => {
    void loadRuns(prKey).catch(() => undefined);
  }, [prKey]);
  const running = runs.filter((r) => r.status === 'running');
  const shown = running[0] ?? runs[0];
  if (!shown) return null;
  const open = () => updateUi(prKey, { showRuns: true });
  return (
    <button type="button" onClick={open} title="Quick actions running in the background: show their output" className="inline-flex items-center gap-1.5 hover:text-fg cursor-pointer">
      {shown.status === 'running' ? <span className="w-3 h-3 rounded-full border-2 border-line-2 border-t-accent animate-spin" aria-hidden="true" /> : <span className={MARK[shown.status].className}>{MARK[shown.status].mark}</span>}
      <span className="text-fg">{shown.name}</span>
      {shown.status === 'running' ? <Elapsed run={shown} /> : <span>{MARK[shown.status].label}</span>}
      {running.length > 1 && <span>+{running.length - 1} more</span>}
    </button>
  );
}

/** Background quick actions on this PR: their output, and stopping, rerunning or clearing them. */
export function RunsDialog({ prKey }: { prKey: string }) {
  const runs = useRuns(prKey);
  const actions = useQuickActions((s) => s.actions);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const output = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const close = () => updateUi(prKey, { showRuns: false });
  const run = runs.find((r) => r.id === selectedId) ?? runs[0];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // Follow the output as it comes, unless scrolled up to read.
  useLayoutEffect(() => {
    const el = output.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [run?.output, run?.id]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-labelledby="runs-h" className="w-[900px] max-w-[calc(100vw-32px)] h-[min(640px,calc(100vh-64px))] flex flex-col rounded-xl bg-raised border border-line-2 shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-line">
          <h2 id="runs-h" className="text-[15px] font-bold text-strong">
            Quick actions
          </h2>
          <span className="text-muted">running in the background</span>
          <span className="flex-1" />
          <button type="button" aria-label="Close" onClick={close} className="grid place-items-center w-[26px] h-[26px] rounded-md text-muted hover:text-fg cursor-pointer">
            <Icon name="close" size={13} />
          </button>
        </div>
        {runs.length === 0 ? (
          <div className="p-4 text-muted">Nothing has run here yet. Background quick actions show their output here.</div>
        ) : (
          <div className="flex-1 min-h-0 flex">
            <ul aria-label="Runs" className="w-[240px] flex-none overflow-y-auto border-r border-line bg-side">
              {runs.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    aria-current={r.id === run?.id}
                    onClick={() => setSelectedId(r.id)}
                    className={cx('w-full flex flex-col gap-0.5 px-3 py-2 text-left border-b border-line cursor-pointer', r.id === run?.id ? 'bg-active' : 'hover:bg-hover')}
                  >
                    <span className="flex items-center gap-1.5 min-w-0">
                      {r.status === 'running' ? <Spinner /> : <span className={MARK[r.status].className}>{MARK[r.status].mark}</span>}
                      <span className="font-semibold text-strong truncate">{r.name}</span>
                    </span>
                    <span className="text-[11.5px] text-muted truncate">
                      {r.file ? `${r.file} · ` : ''}
                      {MARK[r.status].label}
                      {r.exitCode !== null && r.status === 'failed' ? ` (exit ${r.exitCode})` : ''} · <Elapsed run={r} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {run && (
              <div className="flex-1 min-w-0 flex flex-col">
                <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
                  <code className="flex-1 min-w-0 truncate font-mono text-[12px] text-soft" title={run.command}>
                    {run.command}
                  </code>
                  <Button
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard.writeText(plainOutput(run.output));
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                  >
                    {copied ? 'Copied' : 'Copy output'}
                  </Button>
                  {run.status === 'running' ? (
                    <Button size="sm" variant="danger" onClick={() => void api.stopQuickAction(run.id)}>
                      Stop
                    </Button>
                  ) : (
                    <>
                      {actions.some((a) => a.id === run.actionId) && (
                        <Button size="sm" onClick={() => void runQuickAction(prKey, run.actionId, run.file)}>
                          Run again
                        </Button>
                      )}
                      <Button
                        size="sm"
                        onClick={() => {
                          setSelectedId(null);
                          dismissRun(prKey, run.id);
                        }}
                      >
                        Clear
                      </Button>
                    </>
                  )}
                </div>
                <pre
                  ref={output}
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                  }}
                  className="flex-1 min-h-0 overflow-auto m-0 p-3 bg-inset font-mono text-[12px] leading-relaxed text-fg whitespace-pre-wrap break-words select-text"
                >
                  {plainOutput(run.output) || (run.status === 'running' ? 'No output yet…' : 'No output.')}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
