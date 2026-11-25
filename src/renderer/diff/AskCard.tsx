import type { AgentTurn, PrSnapshot } from '../../shared/model';
import { Badge, Icon, Spinner } from '../components/ui';
import { api, errorText } from '../api';
import { setSessionError } from '../state/sessions';
import { showTurn } from '../state/ui';

const STATUS: Record<AgentTurn['status'], { label: string; tone: 'muted' | 'info' | 'ok' | 'bad' }> = {
  queued: { label: 'Waiting', tone: 'muted' },
  running: { label: 'Working…', tone: 'info' },
  done: { label: 'Answered', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  stopped: { label: 'Stopped', tone: 'muted' },
  'handed-off': { label: 'Sent', tone: 'info' },
};

/**
 * Marks the lines a question was asked about ("Ask" in the comment editor). The answer lives in the Agent panel, not
 * here, so the diff shows code and comments only; a comment the agent writes goes into your review on the line.
 */
export function AskCard({ snapshot, turn }: { snapshot: PrSnapshot; turn: AgentTurn }) {
  const key = snapshot.key;
  const status = STATUS[turn.status];
  return (
    // The buttons follow the text rather than sitting at the far right: the row is as wide as the code, which can be
    // wider than the visible panel, and the panel divider's grab area would cover them there.
    <div id={`ask-${turn.id}`} className="flex items-center gap-2 text-[12px] text-muted font-sans">
      <Icon name="comment" size={13} className="text-accent" />
      <span className="min-w-0 max-w-[360px] truncate" title={turn.request.prompt.trim()}>
        Asked {turn.agent}: <span className="text-fg">{turn.request.prompt.trim() || '(no text)'}</span>
      </span>
      {turn.status === 'running' && <Spinner />}
      <Badge tone={status.tone}>{status.label}</Badge>
      <button type="button" onClick={() => showTurn(key, turn.id)} className="flex-none text-link hover:underline cursor-pointer">
        Show in Agent panel
      </button>
      {turn.endedAt && (
        <button
          type="button"
          aria-label="Hide this marker"
          title="Hide this marker (the conversation stays in the Agent panel)"
          onClick={() => void api.hideAskMarker(key, turn.id).catch((err: unknown) => setSessionError(key, errorText(err)))}
          className="grid place-items-center w-[22px] h-[22px] rounded-md hover:text-fg cursor-pointer"
        >
          <Icon name="close" size={11} />
        </button>
      )}
    </div>
  );
}
