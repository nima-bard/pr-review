import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useMemo, useRef, type ButtonHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { parsePrInput } from '../../shared/prInput';
import { appTheme } from '../../shared/themes';
import { api } from '../api';
import { useAppSettings } from '../state/settings';
import { openPrLink } from '../state/tabs';
import { renderMermaid } from './mermaid';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';

export function Button({ variant = 'secondary', size = 'md', className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-[7px] font-medium whitespace-nowrap cursor-pointer disabled:opacity-50 disabled:cursor-default',
        size === 'sm' ? 'h-[26px] px-2.5 text-[12px]' : 'h-8 px-3 text-[13px]',
        variant === 'primary' && 'bg-accent text-ink font-semibold hover:brightness-110',
        variant === 'secondary' && 'bg-raised-2 border border-line-2 text-fg hover:bg-btn-hover',
        variant === 'ghost' && 'text-muted hover:text-fg hover:bg-raised',
        variant === 'danger' && 'bg-del-bg border border-del-line text-del hover:brightness-110',
        variant === 'success' && 'bg-success-emphasis text-white font-semibold hover:brightness-110',
        className,
      )}
    />
  );
}

export function Select({ surface = 'card', className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { surface?: 'card' | 'raised' }) {
  return (
    <span className={cx('relative inline-flex', className)}>
      <select
        {...rest}
        className={cx(
          'w-full h-9 pl-3 pr-9 rounded-lg border border-line-2 focus:border-accent outline-none appearance-none font-mono text-[12.5px] text-fg cursor-pointer',
          surface === 'card' ? 'bg-card' : 'bg-raised',
        )}
      >
        {children}
      </select>
      <span aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted">
        <Icon name="chevron" size={12} />
      </span>
    </span>
  );
}

export function Badge({ tone = 'muted', children, className }: { tone?: 'muted' | 'info' | 'warn' | 'ok' | 'bad' | 'purple'; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-px text-[11px] font-semibold whitespace-nowrap',
        tone === 'muted' && 'bg-chip text-soft',
        tone === 'info' && 'bg-info-bg text-info',
        tone === 'warn' && 'bg-warn-bg text-warn',
        tone === 'ok' && 'bg-add-bg text-add-strong',
        tone === 'bad' && 'bg-del-bg text-del-strong',
        tone === 'purple' && 'bg-purple-bg text-purple',
        className,
      )}
    >
      {children}
    </span>
  );
}

const AVATAR_COLORS = ['#5b4bb7', '#1f7a5a', '#9a4a2f', '#2f5fb3', '#7a5a1f', '#8a3b6b', '#3b6b8a'];

export function Avatar({ login, url, size = 22 }: { login: string; url?: string | null; size?: number }) {
  const color = AVATAR_COLORS[[...login].reduce((h, c) => h + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
  if (url) return <img src={url} alt="" aria-hidden="true" width={size} height={size} className="rounded-full flex-none" style={{ width: size, height: size }} />;
  return (
    <span aria-hidden="true" className="grid place-items-center rounded-full text-white font-bold flex-none" style={{ width: size, height: size, background: color, fontSize: size * 0.4 }}>
      {login.slice(0, 2).toUpperCase()}
    </span>
  );
}

/** True on a light app theme; for colours that can't come from the palette (GitHub label colours, Mermaid). */
export function useLightTheme(): boolean {
  return useAppSettings((s) => appTheme(s.appTheme).kind === 'light');
}

/** Perceived brightness of a GitHub label colour ("rrggbb"), 0–1. */
function brightness(hex: string): number {
  const n = Number.parseInt(hex.slice(0, 6), 16);
  return (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) / 255;
}

/** A GitHub label like github.com draws it: tinted on dark themes, filled with readable text on light ones. */
export function Label({ name, color, className }: { name: string; color: string; className?: string }) {
  const light = useLightTheme();
  const style = light
    ? { background: `#${color}`, color: brightness(color) > 0.6 ? '#1f2328' : '#ffffff', borderColor: 'transparent' }
    : { color: `#${color}`, borderColor: `#${color}66`, background: `#${color}1f` };
  return (
    <span className={cx('px-2 rounded-full text-[11.5px] border', className)} style={style}>
      {name}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="font-mono text-[11px] px-1.5 rounded bg-chip text-soft">{children}</kbd>;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
  stretch = false,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange(v: T): void;
  label: string;
  size?: 'sm' | 'md';
  stretch?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className={cx('p-0.5 rounded-lg bg-raised border border-line-2', stretch ? 'flex' : 'inline-flex w-fit')}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'rounded-md font-semibold cursor-pointer flex items-center justify-center gap-1.5',
            stretch && 'flex-1',
            size === 'sm' ? 'h-[22px] px-2 text-[11.5px]' : 'h-[26px] px-3 text-[12.5px]',
            value === o.value ? 'bg-sel text-strong' : 'text-soft hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Markdown({ html, className }: { html: string; className?: string }) {
  const clean = useMemo(() => DOMPurify.sanitize(html, { ADD_ATTR: ['target'] }), [html]);
  const ref = useRef<HTMLDivElement>(null);
  const light = useLightTheme();
  useEffect(() => {
    if (ref.current) void renderMermaid(ref.current, light);
  }, [clean, light]);
  return (
    <div
      // A new node on a theme change, so diagrams already drawn are drawn again in the new colours.
      key={light ? 'light' : 'dark'}
      ref={ref}
      className={cx('markdown', className)}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a');
        if (a?.href.startsWith('https://')) {
          e.preventDefault();
          // A pull request link opens in the app; ⌘-click opens it on GitHub instead.
          if (!e.metaKey && parsePrInput(a.href)) openPrLink(a.href);
          else void api.openExternal(a.href);
        }
      }}
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}

/**
 * Markdown written in the app (drafts, agent replies), rendered like GitHub's comments: GitHub-flavoured, line breaks
 * kept, and through `Markdown`, so it's sanitized and links behave the same.
 */
export function MarkdownText({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => marked.parse(text, { gfm: true, breaks: true, async: false }), [text]);
  return <Markdown html={html} className={className} />;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

/** A placeholder bar that pulses while what goes there loads; size it with `className`. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cx('block rounded-md bg-raised-2 animate-pulse', className)} />;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-muted text-[12.5px]">
      <span className="w-3.5 h-3.5 rounded-full border-2 border-line-2 border-t-accent animate-spin" aria-hidden="true" />
      {label}
    </div>
  );
}

const ICONS = {
  plus: 'M8 3v10M3 8h10',
  close: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  chevron: 'M4 6l4 4 4-4',
  search: 'M10 10l3.5 3.5M11 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  folder: 'M2 4.5h4l1.5 1.5H14v6.5H2z',
  file: 'M4 2h5l3 3v9H4zM9 2v3h3',
  comment: 'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z',
  check: 'M3 8.5l3 3 7-7',
  info: 'M8 7.2v3.8M8 5h.01M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0',
  refresh: 'M2.5 8a5.5 5.5 0 0 1 9.4-3.9M13.5 8a5.5 5.5 0 0 1-9.4 3.9M12 1.5v3h-3M4 14.5v-3h3',
  branch: 'M4.5 5v6M11.5 11V7.5a2 2 0 0 0-2-2H8M6 3.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0M6 12.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0M13 12.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0',
  external: 'M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5',
  list: 'M3 4h10M3 8h10M3 12h10',
  lock: 'M4.5 7V5a3.5 3.5 0 0 1 7 0v2M3.5 7h9v6.5h-9z',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5',
  sidebar: 'M2 3h12v10H2zM6 3v10',
  sliders: 'M2.5 4.5h11M2.5 11.5h11M10 3v3M6 10v3',
  /** The return key (↵), for sending. */
  enter: 'M13 3.5v4.5a2 2 0 0 1-2 2H3.5M6.5 7l-3 3 3 3',
};

export function Icon({ name, size = 14, className, rotate }: { name: keyof typeof ICONS; size?: number; className?: string; rotate?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cx('flex-none', className)}
      style={rotate ? { transform: `rotate(${rotate}deg)` } : undefined}
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-del-line bg-del-subtle px-3 py-2 text-del-strong">
      <Icon name="info" className="mt-0.5" />
      <span className="flex-1 whitespace-pre-wrap">{message}</span>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '';
}
