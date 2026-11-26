import type { Ask } from '../../shared/agents';
import type { PrSnapshot } from '../../shared/model';
import { Badge, Icon, Spinner } from '../components/ui';
import { api, errorText } from '../api';
import { setSessionError } from '../state/sessions';
import { showAsk } from '../state/ui';

export const ASK_STATUS: Record<Ask['status'], { label: string; tone: 'muted' | 'info' | 'ok' | 'bad' }> = {
  waiting: { label: 'Waiting', tone: 'muted' },
  sent: { label: 'Sent', tone: 'info' },
  failed: { label: 'Not sent', tone: 'bad' },
  answering: { label: 'Answering…', tone: 'info' },
  answered: { label: 'Answered', tone: 'ok' },
  stopped: { label: 'Stopped', tone: 'muted' },
};

/**
 * Marks the lines a question was asked about ("Ask Claude" in the comment editor). The answer is in the side panel,
 * not here, so the diff shows code and comments only; a comment Claude writes goes into your review on the line.
 */
export function AskCard({ snapshot, ask }: { snapshot: PrSnapshot; ask: Ask }) {
  const key = snapshot.key;
  const status = ASK_STATUS[ask.status];
  // Only a question in the session can be hidden; one on its way is cancelled in the conversation.
  const hideable = ask.status === 'answered' || ask.status === 'stopped';
  return (
    // The buttons follow the text rather than sitting at the far right: the row is as wide as the code, which can be
    // wider than the visible panel, and the panel divider's grab area would cover them there.
    <div id={`ask-${ask.id}`} className="flex items-center gap-2 text-[12px] text-muted font-sans">
      <Icon name="comment" size={13} className="text-accent" />
      <span className="min-w-0 max-w-[360px] truncate" title={ask.request.prompt.trim()}>
        Asked Claude: <span className="text-fg">{ask.request.prompt.trim() || '(no text)'}</span>
      </span>
      {ask.status === 'answering' && <Spinner />}
      <Badge tone={status.tone}>{status.label}</Badge>
      <button type="button" onClick={() => showAsk(key, ask.id)} className="flex-none text-link hover:underline cursor-pointer">
        Show in conversation
      </button>
      {hideable && (
        <button
          type="button"
          aria-label="Hide this marker"
          title="Hide this marker (the question stays in the session and the conversation)"
          onClick={() => void api.hideAskMarker(key, ask.id).catch((err: unknown) => setSessionError(key, errorText(err)))}
          className="grid place-items-center w-[22px] h-[22px] rounded-md hover:text-fg cursor-pointer"
        >
          <Icon name="close" size={11} />
        </button>
      )}
    </div>
  );
}
