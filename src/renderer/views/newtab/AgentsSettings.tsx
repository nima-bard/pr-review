import { useEffect, useRef, useState } from 'react';
import type { AgentConnector, McpStatus } from '../../../shared/model';
import { AGENT_PRESETS, CONNECTOR_KINDS } from '../../../shared/agents';
import { api, errorText } from '../../api';
import { Badge, Button, cx, ErrorBox, Select, Spinner } from '../../components/ui';
import { setAgents } from '../../state/agents';
import { setSettingsStatus } from '../../state/settingsPage';

const INPUT = 'h-8 px-2.5 rounded-md bg-side border border-line-2 focus:border-accent outline-none';

function newConnector(from: Omit<AgentConnector, 'id'>): AgentConnector {
  return { ...from, id: crypto.randomUUID() };
}

function ConnectorEditor({ connector, onChange, onDone }: { connector: AgentConnector; onChange(patch: Partial<AgentConnector>): void; onDone(): void }) {
  const name = useRef<HTMLInputElement>(null);
  useEffect(() => name.current?.focus(), []);
  return (
    <div className="flex flex-col gap-3 p-3 rounded-[9px] border border-info-line bg-panel">
      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-semibold text-strong">Name</span>
        <input ref={name} value={connector.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="e.g. Claude" className={INPUT} />
        <span className="text-[11.5px] text-muted">Shown on the buttons: “Review with {connector.name || '…'}”, “Ask {connector.name || '…'}”.</span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-semibold text-strong">Kind</span>
        <Select value={connector.kind} onChange={(e) => onChange({ kind: e.target.value as AgentConnector['kind'] })} className="w-[320px]">
          {Object.entries(CONNECTOR_KINDS).map(([kind, k]) => (
            <option key={kind} value={kind}>
              {k.label}
            </option>
          ))}
        </Select>
        <span className="text-[11.5px] text-muted">{CONNECTOR_KINDS[connector.kind].desc}</span>
      </label>
      {connector.kind === 'command' && (
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-semibold text-strong">Command</span>
          <textarea
            rows={2}
            value={connector.command}
            onChange={(e) => onChange({ command: e.target.value })}
            spellCheck={false}
            placeholder={'e.g. codex exec "$PR_PROMPT"'}
            className="px-2.5 py-2 rounded-md bg-side border border-line-2 focus:border-accent outline-none font-mono text-[12.5px] resize-y"
          />
          <span className="text-[11.5px] text-muted">
            Use <code className="font-mono">"$PR_PROMPT"</code> in double quotes. For its comments to go into your review, give the agent PR Review’s MCP server (below).
          </span>
        </label>
      )}
      {(connector.kind === 'claude-code' || connector.kind === 'claude-terminal') && (
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-semibold text-strong">Model</span>
          <input value={connector.model} onChange={(e) => onChange({ model: e.target.value.trim() })} placeholder="(Claude Code's default)" spellCheck={false} className={cx(INPUT, 'w-[240px] font-mono text-[12.5px]')} />
          <span className="text-[11.5px] text-muted">An alias (opus, sonnet) or a model id. Empty uses your Claude Code default.</span>
        </label>
      )}
      <div>
        <Button size="sm" variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

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
        Agents use it to read the pull requests open here and add draft comments to your review. It only listens on this Mac, asks for a token, and can’t post anything to GitHub.
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
 * Settings › Agents: the agents the app can ask (Claude first), and PR Review's MCP server, which gives agents the pull
 * requests and your review. Empty until you set one up; the agent buttons appear only then.
 */
export function AgentsSettings() {
  const [connectors, setConnectors] = useState<AgentConnector[] | null>(null);
  const [port, setPort] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [claudeInstalled, setClaudeInstalled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void api.getSettings().then((s) => {
      setConnectors(s.agents);
      setPort(s.mcpPort);
    });
    void api.mcpStatus().then((s) => setClaudeInstalled(s.claudeInstalled));
  }, []);

  /** Saves these settings over the latest saved ones (the rest of Settings saves separately). */
  const save = (patch: { agents?: AgentConnector[]; mcpPort?: number }, wait = 400) => {
    setSettingsStatus('Saving…');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void (async () => {
        try {
          const current = await api.getSettings();
          await api.saveSettings({ ...current, ...patch });
          if (patch.agents) setAgents(patch.agents);
          setSettingsStatus('Saved');
        } catch (err) {
          setSettingsStatus(errorText(err));
        }
      })();
    }, wait);
  };

  if (!connectors) return null;
  const update = (next: AgentConnector[], wait?: number) => {
    setConnectors(next);
    save({ agents: next }, wait);
  };
  const change = (id: string, patch: Partial<AgentConnector>) => update(connectors.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const move = (index: number, by: number) => {
    const next = [...connectors];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    update(next);
  };
  const add = (from: Omit<AgentConnector, 'id'>) => {
    const a = newConnector(from);
    update([...connectors, a]);
    setEditing(a.id);
  };
  /** One click: the Claude agent, and Claude Code connected to the MCP server (after a confirm). */
  const setUpClaude = async () => {
    setError(null);
    if (!connectors.some((c) => c.kind === 'claude-code')) update([newConnector(AGENT_PRESETS[0]!), ...connectors], 0);
    try {
      await api.connectClaudeCode();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const hasClaude = connectors.some((c) => c.kind === 'claude-code');

  return (
    <div className="flex flex-col gap-4">
      {!hasClaude && (
        <div className="flex flex-col gap-2 p-3.5 rounded-[10px] bg-info-subtle border border-info-line">
          <span className="font-semibold text-strong">Review with Claude</span>
          <span className="text-[12.5px] text-fg leading-relaxed">
            Claude reviews a pull request with your skills and guidelines, answers questions about a line, and keeps one conversation per pull request that you can open in Claude Desktop. Requests run straight away
            on your Claude Code. Its comments go into your review as drafts; nothing goes to GitHub until you submit.
          </span>
          <span className="text-[12px] text-muted">Set up Claude also adds PR Review’s MCP server (“pr-review”) to your Claude Code settings for all projects.</span>
          {claudeInstalled === false ? (
            <span className="text-[12.5px] text-fg">
              Claude Code isn’t installed.{' '}
              <button type="button" onClick={() => void api.openExternal('https://code.claude.com/docs/en/setup')} className="text-link hover:underline cursor-pointer">
                Install it
              </button>
              , then come back here.
            </span>
          ) : (
            <Button variant="primary" className="w-fit" disabled={claudeInstalled === null} onClick={() => void setUpClaude()}>
              Set up Claude
            </Button>
          )}
          {error && <ErrorBox message={error} />}
        </div>
      )}
      <div className="flex flex-col gap-2">
        {connectors.length > 0 && <span className="text-[12px] text-muted">The first agent is the default for every pull request; the Agent panel switches one pull request to another.</span>}
        {connectors.map((a, i) =>
          editing === a.id ? (
            <ConnectorEditor key={a.id} connector={a} onChange={(patch) => change(a.id, patch)} onDone={() => setEditing(null)} />
          ) : (
            <div key={a.id} className="flex items-start gap-2.5 px-3 py-2.5 rounded-[9px] border border-line-2 bg-panel">
              <div className="flex-1 min-w-0 flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-semibold text-strong">{a.name || 'Untitled'}</span>
                  <Badge tone="muted">{CONNECTOR_KINDS[a.kind].label}</Badge>
                  {i === 0 && <Badge tone="info">Default</Badge>}
                  {a.model && <Badge tone="muted">{a.model}</Badge>}
                </div>
                {a.kind === 'command' && (
                  <code className="font-mono text-[12px] text-soft truncate" title={a.command}>
                    {a.command || '(no command)'}
                  </code>
                )}
              </div>
              <Button size="sm" onClick={() => setEditing(a.id)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" aria-label={`Move ${a.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </Button>
              <Button size="sm" variant="ghost" aria-label={`Move ${a.name} down`} disabled={i === connectors.length - 1} onClick={() => move(i, 1)}>
                ↓
              </Button>
              <Button size="sm" variant="ghost" aria-label={`Delete ${a.name}`} onClick={() => update(connectors.filter((x) => x.id !== a.id))}>
                Delete
              </Button>
            </div>
          ),
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-muted">Add</span>
        {AGENT_PRESETS.map((p) => (
          <Button key={p.name} size="sm" variant="ghost" onClick={() => add(p)}>
            {p.name}
          </Button>
        ))}
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
