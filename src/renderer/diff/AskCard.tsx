import type { AgentTurn, PrSnapshot } from '../../shared/model';
import { Badge, Icon, Spinner } from '../components/ui';
import { showTurn, updateUi, usePrUi } from '../state/ui';

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
 * here, so the diff shows code and comments only; any comment the agent suggests arrives on the line as a suggestion.
 */
export function AskCard({ snapshot, turn }: { snapshot: PrSnapshot; turn: AgentTurn }) {
  const key = snapshot.key;
  const hidden = usePrUi(key).hiddenAsks;
  const status = STATUS[turn.status];
  return (
    <div className="max-w-[680px] flex items-center gap-2 text-[12px] text-muted font-sans">
      <Icon name="comment" size={13} className="text-accent" />
      <span className="min-w-0 truncate" title={turn.request.prompt.trim()}>
        Asked {turn.agent}: <span className="text-fg">{turn.request.prompt.trim() || '(no text)'}</span>
      </span>
      {turn.status === 'running' && <Spinner />}
      <Badge tone={status.tone}>{status.label}</Badge>
      <span className="flex-1" />
      <button type="button" onClick={() => showTurn(key, turn.id)} className="flex-none text-link hover:underline cursor-pointer">
        Show in Agent panel
      </button>
      {turn.endedAt && (
        <button
          type="button"
          aria-label="Hide this marker"
          title="Hide this marker (the conversation stays in the Agent panel)"
          onClick={() => updateUi(key, { hiddenAsks: { ...hidden, [turn.id]: true } })}
          className="grid place-items-center w-[22px] h-[22px] rounded-md hover:text-fg cursor-pointer"
        >
          <Icon name="close" size={11} />
        </button>
      )}
    </div>
  );
}
