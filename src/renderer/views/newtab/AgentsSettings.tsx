import { useEffect, useRef, useState } from 'react';
import { EFFORT_NAMES, modelChoices } from '../../../shared/agents';
import type { ClaudeEffort, ClaudeModels, ClaudeSettings, McpStatus } from '../../../shared/model';
import { api, errorText } from '../../api';
import { Badge, Button, ErrorBox, Select, Spinner } from '../../components/ui';
import { loadClaudeModels, setClaudeSettings } from '../../state/claude';
import { setSettingsStatus } from '../../state/settingsPage';

/** The MCP server: whether it runs, Claude Code's registration, the port, and the settings other clients need. */
function McpServerBox({ port, onPort }: { port: number; onPort(port: number): void }) {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const refresh = () => void api.mcpStatus().then(setStatus);
  useEffect(refresh, [port]);
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      refresh();
    }
  };
  if (!status) return <Spinner label="Checking the MCP server…" />;
  return (
    <div className="flex flex-col gap-2.5 p-3.5 rounded-[10px] border border-line-2 bg-card">
      <span className="flex items-center gap-2">
        <span className="font-semibold text-strong">PR Review MCP server</span>
        {status.running ? <Badge tone="ok">Running</Badge> : <Badge tone="bad">Not running</Badge>}
        {status.claudeCodeRegistered && <Badge tone="info">Connected to Claude Code</Badge>}
      </span>
      <span className="text-[12px] text-muted leading-relaxed">
        Claude uses it to read the pull requests open here, add draft comments to your review and show things in the app. It only listens on this Mac, asks for a token, and can’t post anything to GitHub.
      </span>
      <code className="font-mono text-[12px] text-fg">{status.url}</code>
      {status.error && <ErrorBox message={status.error} />}
      {error && <ErrorBox message={error} />}
      <div className="flex flex-wrap items-center gap-2">
        {status.claudeInstalled && (
          <Button size="sm" disabled={busy} onClick={() => void act(() => api.connectClaudeCode())}>
            {status.claudeCodeRegistered ? 'Connect Claude Code again' : 'Connect Claude Code'}
          </Button>
        )}
        <Button
          size="sm"
          onClick={() =>
            void act(async () => {
              await api.copyMcpClientConfig();
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
          }
        >
          {copied ? 'Copied' : 'Copy settings for another client'}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} title="A new token: clients connected with the old one must be connected again" onClick={() => void act(() => api.resetMcpToken())}>
          Reset token
        </Button>
        <span className="flex-1" />
        <label className="flex items-center gap-2 text-[12px] text-muted">
          Port
          <input
            type="number"
            min={1024}
            max={65535}
            defaultValue={port}
            onBlur={(e) => {
              const next = Number(e.target.value);
              if (Number.isInteger(next) && next >= 1024 && next <= 65535 && next !== port) onPort(next);
            }}
            className="h-7 w-[84px] px-2 rounded-md bg-side border border-line-2 font-mono text-[12px] outline-none focus:border-accent"
          />
        </label>
      </div>
      <span className="text-[11.5px] text-muted">
        Claude Code and Claude Desktop’s Code tab share MCP servers, so connecting Claude Code covers both. The copied settings (with the token) suit Cursor, Codex, Gemini CLI and other MCP clients; after a
        port change or a new token, connect them again.
      </span>
    </div>
  );
}

/**
 * The model and effort for questions asked in the app, from the models your Claude Code offers (its /model list) and
 * the effort levels the chosen one supports. A saved model Claude Code doesn't list stays choosable.
 */
function ModelAndEffort({ claude, onChange }: { claude: ClaudeSettings; onChange(patch: Partial<ClaudeSettings>): void }) {
  const [list, setList] = useState<ClaudeModels | null>(null);
  useEffect(() => void loadClaudeModels().then(setList), []);
  if (!list) return <Spinner label="Asking Claude Code for its models…" />;
  const models = modelChoices(list.models, claude.model);
  const chosen = models.find((m) => m.value === claude.model);
  const efforts = chosen?.efforts ?? [];
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-3">
      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-semibold text-strong">Model</span>
        <Select
          value={claude.model}
          // A model without the chosen effort level goes back to its default effort.
          onChange={(e) => {
            const next = models.find((m) => m.value === e.target.value);
            onChange({ model: e.target.value, ...(claude.effort && !next?.efforts.includes(claude.effort) ? { effort: '' } : {}) });
          }}
          className="w-[300px]"
        >
          {models.map((m) => (
            <option key={m.value} value={m.value}>
              {m.description ? `${m.name} · ${m.description}` : m.name}
            </option>
          ))}
        </Select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-semibold text-strong">Effort</span>
        <Select value={efforts.includes(claude.effort as ClaudeEffort) ? claude.effort : ''} disabled={efforts.length === 0} onChange={(e) => onChange({ effort: e.target.value as ClaudeEffort | '' })} className="w-[180px]">
          <option value="">The model’s default</option>
          {efforts.map((e) => (
            <option key={e} value={e}>
              {EFFORT_NAMES[e]}
            </option>
          ))}
        </Select>
      </label>
      <span className="basis-full text-[11.5px] text-muted">
        The default for questions asked in the app: each pull request’s conversation can choose its own, under the box you type in. Claude Desktop and Claude Code keep their own.{' '}
        {list.fromClaudeCode ? 'The models your Claude Code offers.' : 'Claude Code’s own list couldn’t be read, so these are the current models.'}
      </span>
    </div>
  );
}

/**
 * Settings › Claude: Claude in the app (on or off, its model and effort), and PR Review's MCP server, which gives
 * Claude the pull requests and your review.
 */
export function AgentsSettings() {
  const [claude, setClaude] = useState<ClaudeSettings | null>(null);
  const [port, setPort] = useState(0);
  const [claudeInstalled, setClaudeInstalled] = useState<boolean | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void api.getSettings().then((s) => {
      setClaude(s.claude);
      setPort(s.mcpPort);
    });
    void api.mcpStatus().then((s) => setClaudeInstalled(s.claudeInstalled));
  }, []);

  /** Saves these settings over the latest saved ones (the rest of Settings saves separately). */
  const save = (patch: { claude?: ClaudeSettings; mcpPort?: number }, wait = 400) => {
    setSettingsStatus('Saving…');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void (async () => {
        try {
          const current = await api.getSettings();
          await api.saveSettings({ ...current, ...patch });
          if (patch.claude) setClaudeSettings(patch.claude);
          setSettingsStatus('Saved');
        } catch (err) {
          setSettingsStatus(errorText(err));
        }
      })();
    }, wait);
  };

  if (!claude) return null;
  const change = (patch: Partial<ClaudeSettings>, wait?: number) => {
    const next = { ...claude, ...patch };
    setClaude(next);
    save({ claude: next }, wait);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2.5 p-3.5 rounded-[10px] border border-line-2 bg-card">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={claude.enabled} onChange={(e) => change({ enabled: e.target.checked }, 0)} />
          <span className="font-semibold text-strong">Ask Claude about pull requests</span>
        </label>
        <span className="text-[12.5px] text-fg leading-relaxed">
          Each pull request gets one Claude Code session, which is its conversation: questions on a line and what you type in the side panel go into it, and it opens in Claude Desktop or
          Claude Code too. What you ask there shows in the app as well. Claude’s comments go into your review as drafts; nothing goes to GitHub until you submit. PR Review keeps no copy of the conversation.
        </span>
        {claudeInstalled === false && (
          <span className="text-[12.5px] text-fg">
            Claude Code isn’t installed.{' '}
            <button type="button" onClick={() => void api.openExternal('https://code.claude.com/docs/en/setup')} className="text-link hover:underline cursor-pointer">
              Install it
            </button>
            , then come back here.
          </span>
        )}
        {claude.enabled && <ModelAndEffort claude={claude} onChange={(patch) => change(patch, 0)} />}
      </div>
      <McpServerBox
        port={port}
        onPort={(next) => {
          setPort(next);
          save({ mcpPort: next }, 0);
        }}
      />
    </div>
  );
}
