import { finished, type Connector } from './connector';

/** `claude://code/new?folder=…&q=…`: a new Claude Desktop Code session in `folder`, with `prompt` filled in (not sent). */
export function desktopLink(folder: string, prompt: string): string {
  return `claude://code/new?${new URLSearchParams({ folder, q: prompt }).toString()}`;
}

/**
 * Claude Desktop, by hand-off: opens a new Desktop session with the request filled in, and you press Enter there. No
 * route exists into a session that's already open, so each request is a new session, and its replies stay in Desktop;
 * drafts come back over MCP.
 */
export function claudeDesktop(open: (url: string) => Promise<void>): Connector {
  return {
    start(ctx, update) {
      const done = open(desktopLink(ctx.worktree, ctx.prompt)).then(
        () => {
          update({ status: 'handed-off', reply: 'Opened in Claude Desktop with the request filled in. Press Enter there to send it.' });
          return { sessionId: null };
        },
        (err: unknown) => {
          update({ status: 'failed', error: `Could not open Claude Desktop: ${err instanceof Error ? err.message : String(err)}` });
          return { sessionId: null };
        },
      );
      return { ...finished(), done };
    },
  };
}
