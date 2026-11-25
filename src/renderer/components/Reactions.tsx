import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Reaction, ReactionContent } from '../../shared/model';
import { api, errorText } from '../api';
import { Octicon } from './octicons';
import { cx } from './ui';

const REACTIONS: { content: ReactionContent; emoji: string; label: string }[] = [
  { content: 'THUMBS_UP', emoji: '👍', label: '+1' },
  { content: 'THUMBS_DOWN', emoji: '👎', label: '-1' },
  { content: 'LAUGH', emoji: '😄', label: 'Laugh' },
  { content: 'HOORAY', emoji: '🎉', label: 'Hooray' },
  { content: 'CONFUSED', emoji: '😕', label: 'Confused' },
  { content: 'HEART', emoji: '❤️', label: 'Heart' },
  { content: 'ROCKET', emoji: '🚀', label: 'Rocket' },
  { content: 'EYES', emoji: '👀', label: 'Eyes' },
];
const BY_CONTENT = new Map(REACTIONS.map((r) => [r.content, r]));

/**
 * GitHub-style reactions: a smiley that opens the eight-emoji picker, then one pill per reaction in use.
 * The picker is portalled to <body> with fixed positioning, so cards with overflow:hidden can't clip it.
 */
/** `disabled`: shown, but not yet to be changed (the PR is still loading). */
export function Reactions({ prKey, subjectId, reactions, disabled = false }: { prKey: string; subjectId: string; reactions: readonly Reaction[]; disabled?: boolean }) {
  const [picker, setPicker] = useState<{ left: number; top: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!picker) return;
    const close = () => setPicker(null);
    const outside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!popover.current?.contains(t) && !button.current?.contains(t)) close();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [picker]);

  // Keep the picker inside the window: flip above the button near the bottom edge, shift left near the right edge.
  useLayoutEffect(() => {
    const el = popover.current;
    const b = button.current?.getBoundingClientRect();
    if (!picker || !el || !b) return;
    const { width, height } = el.getBoundingClientRect();
    const top = b.bottom + 6 + height > window.innerHeight ? b.top - 6 - height : b.bottom + 6;
    const left = Math.max(8, Math.min(b.left, window.innerWidth - width - 8));
    if (top !== picker.top || left !== picker.left) setPicker({ top, left });
  }, [picker]);

  const toggle = async (content: ReactionContent, add: boolean) => {
    setPicker(null);
    setBusy(true);
    setError(null);
    try {
      await api.react(prKey, subjectId, content, add);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const mine = (c: ReactionContent) => reactions.some((r) => r.content === c && r.viewerHasReacted);

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-2">
      <button
        ref={button}
        type="button"
        aria-label="Add reaction"
        title="Add reaction"
        aria-expanded={picker !== null}
        disabled={busy || disabled}
        onClick={() => {
          const b = button.current?.getBoundingClientRect();
          setPicker(picker || !b ? null : { left: b.left, top: b.bottom + 6 });
        }}
        className="grid place-items-center w-7 h-7 rounded-full border border-line-2 bg-raised-2 text-muted hover:text-fg cursor-pointer disabled:opacity-50"
      >
        <Octicon name="smiley" size={15} />
      </button>
      {reactions.map((r) => {
        const meta = BY_CONTENT.get(r.content);
        if (!meta) return null;
        return (
          <button
            key={r.content}
            type="button"
            aria-pressed={r.viewerHasReacted}
            aria-label={`${meta.label}: ${r.count}${r.viewerHasReacted ? ', including you' : ''}`}
            title={r.viewerHasReacted ? `Remove your ${meta.label}` : `React with ${meta.label}`}
            disabled={busy || disabled}
            onClick={() => void toggle(r.content, !r.viewerHasReacted)}
            className={cx(
              'inline-flex items-center gap-1 h-7 px-2 rounded-full border text-[12px] font-semibold cursor-pointer disabled:opacity-60',
              r.viewerHasReacted ? 'bg-info-bg border-info-line text-info' : 'bg-raised-2 border-line-2 text-soft hover:border-chip-on-line',
            )}
          >
            <span className="text-[14px] leading-none">{meta.emoji}</span>
            {r.count}
          </button>
        );
      })}
      {error && <span className="text-del text-[12px]">{error}</span>}
      {picker &&
        createPortal(
          <div ref={popover} role="menu" aria-label="Pick a reaction" className="fixed z-50 flex gap-0.5 p-1 rounded-lg border border-line-2 bg-raised shadow-xl shadow-black/40" style={{ left: picker.left, top: picker.top }}>
            {REACTIONS.map((r) => (
              <button
                key={r.content}
                type="button"
                role="menuitemcheckbox"
                aria-checked={mine(r.content)}
                aria-label={r.label}
                title={r.label}
                onClick={() => void toggle(r.content, !mine(r.content))}
                className={cx('grid place-items-center w-8 h-8 rounded-md text-[17px] cursor-pointer hover:bg-raised-2', mine(r.content) && 'bg-info-bg')}
              >
                {r.emoji}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
