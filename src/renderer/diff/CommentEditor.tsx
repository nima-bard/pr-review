import { useState } from 'react';
import type { EditableKind } from '../../shared/model';
import { api, errorText } from '../api';
import { Button } from '../components/ui';

/** Inline editor for one of your own comments: Markdown source, ⌘⏎ saves, Esc cancels. */
export function CommentEditor({ prKey, kind, commentId, body, onDone }: { prKey: string; kind: EditableKind; commentId: string; body: string; onDone(): void }) {
  const [text, setText] = useState(body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!text.trim() || busy) return;
    if (text === body) return onDone();
    setBusy(true);
    setError(null);
    try {
      await api.editComment(prKey, kind, commentId, text);
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <div className="relative flex flex-col gap-2 mt-1.5">
      <label className="sr-only" htmlFor={`edit-${commentId}`}>
        Comment text
      </label>
      <textarea
        id={`edit-${commentId}`}
        autoFocus
        value={text}
        rows={Math.min(14, Math.max(3, text.split('\n').length + 1))}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
          if (e.key === 'Escape') onDone();
        }}
        className="resize-y px-2.5 py-2 rounded-[7px] bg-side border border-line-2 focus:border-accent outline-none"
      />
      {error && <div className="text-del text-[12px]">{error}</div>}
      <div className="flex items-center gap-2">
        <span className="text-[11.5px] text-muted">Markdown · ⌘⏎ to save</span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={busy || !text.trim()} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
