import type { AgentTurn, PrSnapshot } from '../../shared/model';
import { Icon } from '../components/ui';
import { updateUi, usePrUi } from '../state/ui';
import { TurnCard } from '../views/pr/AgentPanel';

/** A question asked about these lines ("Ask" in the comment editor) and its answer, on the lines it was asked about. */
export function AskCard({ snapshot, turn }: { snapshot: PrSnapshot; turn: AgentTurn }) {
  const hidden = usePrUi(snapshot.key).hiddenAsks;
  return (
    <div className="max-w-[680px] flex flex-col gap-1.5">
      <span className="flex items-center gap-2 text-[12px] text-muted font-sans">
        <span className="flex-1 min-w-0 truncate">
          You asked {turn.agent}: <span className="text-fg">{turn.request.prompt.trim() || '(no text)'}</span>
        </span>
        {turn.endedAt && (
          <button type="button" aria-label="Hide this answer" title="Hide this answer (it stays in the Agent panel)" onClick={() => updateUi(snapshot.key, { hiddenAsks: { ...hidden, [turn.id]: true } })} className="grid place-items-center w-[22px] h-[22px] rounded-md hover:text-fg cursor-pointer">
            <Icon name="close" size={11} />
          </button>
        )}
      </span>
      <TurnCard snapshot={snapshot} turn={turn} compact />
    </div>
  );
}
