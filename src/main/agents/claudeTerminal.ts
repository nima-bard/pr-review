import { shellQuote } from '../../shared/quickActions';
import { requestLabel } from '../../shared/agents';
import { finished, type Connector, type TurnContext } from './connector';

export interface TerminalDeps {
  /** Opens a terminal in `cwd` running `command` (quick actions' openInTerminal, with the chosen terminal app). */
  openTerminal(cwd: string, env: Record<string, string>, command: string, name: string): Promise<void>;
  channelConnected(key: string): boolean;
  push(key: string, turnId: string, content: string, meta: Record<string, string>): Promise<void>;
}

/** How long a newly opened terminal session gets to start and connect to the MCP server. */
const CONNECT_TIMEOUT_MS = 90_000;

/**
 * The command that starts (or resumes) the PR's live session: Claude Code with PR Review's MCP server for this PR, loaded
 * as a development channel so the app can push requests into it. Every value is single-quoted.
 */
export function terminalCommand(ctx: TurnContext): string {
  // The connection outlives this turn: each pushed request carries its own turn id instead.
  const { 'X-PR-Review-Turn': _turn, ...headers } = ctx.mcp.headers;
  const config = { mcpServers: { 'pr-review': { type: 'http', url: ctx.mcp.url, headers: { ...headers, 'X-PR-Review-Channel': '1' } } } };
  const args = [
    'claude',
    ...(ctx.resume ? ['--resume', ctx.sessionId!] : ['--session-id', ctx.sessionId!]),
    '--mcp-config',
    JSON.stringify(config),
    '--dangerously-load-development-channels',
    'server:pr-review',
    ...(ctx.connector.model ? ['--model', ctx.connector.model] : []),
  ];
  return args.map((a, i) => (i === 0 ? a : shellQuote(a))).join(' ');
}

/**
 * Claude Code live in your terminal: requests are pushed into the PR's interactive session as channel events (a research
 * preview; Team and Enterprise organisations must allow channels). If no session is connected for the PR, it opens one
 * and waits for it. Replies stay in the terminal, unless Claude answers with the reply tool.
 */
export function claudeTerminal(deps: TerminalDeps): Connector {
  return {
    start(ctx, update) {
      let stopped = false;
      const done = (async () => {
        if (!deps.channelConnected(ctx.key)) {
          update({ status: 'running', reply: 'Opening the Claude session in your terminal…' });
          await deps.openTerminal(ctx.worktree, ctx.env, terminalCommand(ctx), `Claude · ${ctx.key}`);
          const until = Date.now() + CONNECT_TIMEOUT_MS;
          while (!deps.channelConnected(ctx.key) && !stopped && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
        }
        if (stopped) {
          update({ status: 'stopped' });
          return { sessionId: null };
        }
        if (!deps.channelConnected(ctx.key)) {
          update({
            status: 'failed',
            error:
              "The Claude session in the terminal didn't connect. Check the terminal: Claude Code must be signed in, and your organisation must allow channels (channelsEnabled). The request wasn't sent.",
          });
          return { sessionId: null };
        }
        const meta: Record<string, string> = { kind: ctx.request.kind, label: requestLabel(ctx.request) };
        if (ctx.request.target) Object.assign(meta, { path: ctx.request.target.path, line: String(ctx.request.target.endLine), side: ctx.request.target.side });
        await deps.push(ctx.key, ctx.turnId, ctx.prompt, meta);
        update({ status: 'handed-off', reply: 'Sent to the Claude session in your terminal.' });
        return { sessionId: ctx.sessionId };
      })().catch((err: unknown) => {
        update({ status: 'failed', error: err instanceof Error ? err.message : String(err) });
        return { sessionId: null };
      });
      return {
        ...finished(),
        stop: () => {
          stopped = true;
        },
        done,
      };
    },
  };
}
