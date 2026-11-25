import { useEffect, useRef, useState } from 'react';
import type { QuickAction } from '../../../shared/model';
import { ACTION_PRESETS, ACTION_VARIABLES } from '../../../shared/quickActions';
import { api, errorText } from '../../api';
import { Octicon } from '../../components/octicons';
import { Badge, Button, cx, Segmented, Select } from '../../components/ui';
import { setQuickActions } from '../../state/quickActions';
import { setSettingsStatus } from '../../state/settingsPage';

const INPUT = 'h-8 px-2.5 rounded-md bg-side border border-line-2 focus:border-accent outline-none';

function newAction(from: Omit<QuickAction, 'id'>): QuickAction {
  return { ...from, id: crypto.randomUUID() };
}

function ActionEditor({ action, onChange, onDone }: { action: QuickAction; onChange(patch: Partial<QuickAction>): void; onDone(): void }) {
  const name = useRef<HTMLInputElement>(null);
  useEffect(() => name.current?.focus(), []);
  return (
    <div className="flex flex-col gap-3 p-3 rounded-[9px] border border-info-line bg-panel">
      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-semibold text-strong">Name</span>
        <input ref={name} value={action.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="e.g. Claude review" className={INPUT} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-semibold text-strong">Command</span>
        <textarea
          rows={3}
          value={action.command}
          onChange={(e) => onChange({ command: e.target.value })}
          spellCheck={false}
          placeholder={action.mode === 'terminal' ? '(empty: just open a shell in the worktree)' : 'e.g. npm test'}
          className="px-2.5 py-2 rounded-md bg-side border border-line-2 focus:border-accent outline-none font-mono text-[12.5px] resize-y"
        />
        <span className="text-[11.5px] text-muted">
          Runs in your login shell, with the pull request’s worktree as the working directory. Use the variables below in double quotes, like <code className="font-mono">"$PR_TITLE"</code>.
        </span>
      </label>
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <div className="flex flex-col gap-1">
          <span className="text-[12px] font-semibold text-strong">Runs</span>
          <Segmented
            label="Where it runs"
            size="sm"
            value={action.mode}
            onChange={(mode) => onChange({ mode })}
            options={[
              { value: 'terminal', label: 'In a terminal' },
              { value: 'background', label: 'In the background' },
            ]}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[12px] font-semibold text-strong">On</span>
          <Segmented
            label="What it runs on"
            size="sm"
            value={action.scope}
            onChange={(scope) => onChange({ scope })}
            options={[
              { value: 'pr', label: 'The pull request' },
              { value: 'file', label: 'A file' },
            ]}
          />
        </div>
      </div>
      <span className="text-[11.5px] text-muted -mt-1.5">
        {action.mode === 'terminal'
          ? 'A new terminal tab or window, where you can answer questions and keep working. For anything interactive, like Claude.'
          : 'Hidden; the status bar shows it running, its output is a click away, and you get a notification when it ends. The pull request syncs after it.'}{' '}
        {action.scope === 'pr' ? 'From the Actions menu; the first nine for a repository also get ⌥⌘1–9.' : 'From a file’s ⋯ menu (and right-click in the file tree), with PR_FILE set.'}
      </span>
      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-semibold text-strong">Repositories</span>
        <input value={action.repos} onChange={(e) => onChange({ repos: e.target.value })} placeholder="All repositories" spellCheck={false} className={cx(INPUT, 'font-mono text-[12.5px]')} />
        <span className="text-[11.5px] text-muted">owner/repo or owner/*, separated by commas. Empty: every repository.</span>
      </label>
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={action.confirm} onChange={(e) => onChange({ confirm: e.target.checked })} style={{ accentColor: 'var(--c-accent)' }} />
        Ask before running
      </label>
      <div>
        <Button size="sm" variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

/**
 * Settings › Quick actions: the commands, the terminal they open in, and the variables they get. Changes save as
 * they're made.
 */
export function QuickActionsSettings() {
  const [actions, setActions] = useState<QuickAction[] | null>(null);
  const [terminal, setTerminal] = useState('');
  const [terminals, setTerminals] = useState<{ id: string; name: string }[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void api.getSettings().then((s) => {
      setActions(s.quickActions);
      setTerminal(s.terminalApp);
    });
    void api.terminalApps().then(setTerminals);
  }, []);

  /** Saves these two settings over the latest saved ones (the rest of the page saves separately). */
  const save = (nextActions: QuickAction[], nextTerminal: string, wait = 400) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void (async () => {
        try {
          const current = await api.getSettings();
          await api.saveSettings({ ...current, quickActions: nextActions, terminalApp: nextTerminal });
          setQuickActions(nextActions);
          setSettingsStatus('Saved');
        } catch (err) {
          setSettingsStatus(errorText(err));
        }
      })();
    }, wait);
  };

  if (!actions) return null;
  const update = (next: QuickAction[]) => {
    setActions(next);
    setSettingsStatus('Saving…');
    save(next, terminal);
  };
  const change = (id: string, patch: Partial<QuickAction>) => update(actions.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const move = (index: number, by: number) => {
    const next = [...actions];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    update(next);
  };
  const add = (from: Omit<QuickAction, 'id'>) => {
    const a = newAction(from);
    update([...actions, a]);
    setEditing(a.id);
  };
  const auto = terminals[0]?.name ?? 'Terminal';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-3 px-3.5 py-3 rounded-[10px] bg-info-subtle border border-info-line">
        <Octicon name="file-directory" size={16} className="text-info mt-0.5" />
        <div className="flex flex-col gap-1.5 text-[12.5px] text-fg leading-relaxed">
          <p>
            <strong className="text-strong">Every action runs inside the pull request’s worktree</strong>: its working directory is the folder shown in the pull request’s status bar (also in{' '}
            <code className="font-mono text-[12px]">$PR_WORKTREE</code>), with the pull request’s head checked out. So <code className="font-mono text-[12px]">npm test</code> tests the pull request’s code,{' '}
            <code className="font-mono text-[12px]">git diff "$PR_MERGE_BASE"</code> shows its changes, and <code className="font-mono text-[12px]">claude</code> starts in its repository.
          </p>
          <p className="text-muted">On your own pull requests that can be your clone itself, when the branch is checked out there (with your local changes). The pull request’s details come in environment variables, listed below.</p>
        </div>
      </div>
      <label className="flex items-center gap-2.5">
        <span className="text-[12.5px] text-fg">Terminal</span>
        <Select
          value={terminal}
          onChange={(e) => {
            setTerminal(e.target.value);
            setSettingsStatus('Saving…');
            save(actions, e.target.value, 0);
          }}
          className="w-[240px]"
        >
          <option value="">Automatic ({auto})</option>
          {terminals.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        <span className="text-[11.5px] text-muted">{(terminal || terminals[0]?.id) === 'iterm' ? 'Opens a new tab in the front window.' : 'Opens a new window.'}</span>
      </label>
      <div className="flex flex-col gap-2">
        {actions.length === 0 && <div className="text-[12.5px] text-muted">No quick actions yet. Start from a preset below, or make a new one.</div>}
        {actions.map((a, i) =>
          editing === a.id ? (
            <ActionEditor key={a.id} action={a} onChange={(patch) => change(a.id, patch)} onDone={() => setEditing(null)} />
          ) : (
            <div key={a.id} className="flex items-start gap-2.5 px-3 py-2.5 rounded-[9px] border border-line-2 bg-panel">
              <div className="flex-1 min-w-0 flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-semibold text-strong">{a.name || 'Untitled'}</span>
                  <Badge tone="muted">{a.mode === 'terminal' ? 'Terminal' : 'Background'}</Badge>
                  <Badge tone="muted">{a.scope === 'pr' ? 'Pull request' : 'File'}</Badge>
                  {a.repos.trim() && <Badge tone="info">{a.repos.trim()}</Badge>}
                  {a.confirm && <Badge tone="muted">Asks first</Badge>}
                </div>
                <code className="font-mono text-[12px] text-soft truncate" title={a.command}>
                  {a.command || '(opens a shell in the worktree)'}
                </code>
              </div>
              <Button size="sm" onClick={() => setEditing(a.id)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" aria-label={`Move ${a.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </Button>
              <Button size="sm" variant="ghost" aria-label={`Move ${a.name} down`} disabled={i === actions.length - 1} onClick={() => move(i, 1)}>
                ↓
              </Button>
              <Button size="sm" variant="ghost" aria-label={`Delete ${a.name}`} onClick={() => update(actions.filter((x) => x.id !== a.id))}>
                Delete
              </Button>
            </div>
          ),
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => add({ name: '', command: '', mode: 'terminal', scope: 'pr', repos: '', confirm: false })}>
          New action
        </Button>
        <span className="text-[12px] text-muted">or start from</span>
        {ACTION_PRESETS.map((p) => (
          <Button key={p.name} size="sm" variant="ghost" onClick={() => add(p)}>
            {p.name}
          </Button>
        ))}
      </div>
      <details className="text-[12px]">
        <summary className="cursor-pointer w-fit text-muted">Variables</summary>
        <table className="mt-2 w-full">
          <tbody>
            {ACTION_VARIABLES.map((v) => (
              <tr key={v.name} className="border-t border-line">
                <td className="py-1 pr-3 font-mono text-fg whitespace-nowrap align-top">${v.name}</td>
                <td className="py-1 text-muted">
                  {v.desc}
                  {v.file ? ' (file actions)' : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
