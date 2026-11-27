import { MultiFileDiff } from '@pierre/diffs/react';
import { useEffect, useRef, useState } from 'react';
import type { AuthStatus, BrowserExtensionInfo, RepoMapping, Settings } from '../../../shared/model';
import iconLicense from 'material-icon-theme/LICENSE?raw';
import octiconsLicense from '../../components/octicons.LICENSE.txt?raw';
import hydraLicense from '../../diff/hydra/LICENSE.txt?raw';
import { APP_THEMES, DARK_CODE_THEMES, LIGHT_CODE_THEMES, type AppTheme } from '../../../shared/themes';
import { api, errorText } from '../../api';
import { Button, cx, ErrorBox, Select, Spinner } from '../../components/ui';
import { Octicon, type OcticonName } from '../../components/octicons';
import { setSettingsStatus, showSettingsSection, useSettingsPage, type SettingsSection } from '../../state/settingsPage';
import { CODE_FONT_SUGGESTIONS, UI_FONT_SUGGESTIONS, useFontStatus, type FontSlot } from '../../state/fonts';
import { applyAppSettings, useAppSettings, useDiffAppearance } from '../../state/settings';
import { showSetup } from '../../state/setup';
import { checkForUpdate, useUpdates } from '../../state/updates';
import { QuickActionsSettings } from './QuickActionsSettings';
import { AgentsSettings } from './AgentsSettings';

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-semibold text-strong">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-muted">{hint}</span>}
    </label>
  );
}

export const INPUT = 'h-9 px-3 rounded-lg bg-card border border-line-2 focus:border-accent outline-none font-mono text-[12.5px]';

const PREVIEW_OLD = {
  name: 'review.ts',
  contents: `import { fetchThreads } from './github';

export async function openReview(pr: number, token?: string) {
  const threads = await fetchThreads(pr);
  // TODO: handle outdated threads
  return threads.filter((t) => !t.isResolved);
}
`,
};

const PREVIEW_NEW = {
  name: 'review.ts',
  contents: `import { fetchThreads, reanchor } from './github';

const MAX_RETRIES = 3;

export async function openReview(pr: number, token: string | null = null) {
  const threads = await fetchThreads(pr, { retries: MAX_RETRIES });
  return threads.filter((t) => !t.isResolved).map((t) => reanchor(t, "HEAD"));
}
`,
};

function Slider({ min, max, value, unit, onChange }: { min: number; max: number; value: number; unit: string; onChange(v: number): void }) {
  return (
    <span className="flex items-center gap-3">
      <input type="range" min={min} max={max} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} className="flex-1 cursor-pointer" style={{ accentColor: 'var(--c-accent)' }} />
      <span className="font-mono text-[12.5px] text-fg w-10 text-right">
        {value}
        {unit}
      </span>
    </span>
  );
}

const FONT_STATUS: Record<string, string> = {
  builtin: 'Built-in font.',
  loading: 'Loading from Google Fonts…',
  loaded: 'Loaded from Google Fonts.',
  failed: "Couldn't load this from Google Fonts (check the name or your connection); the built-in font is used.",
};

/** Any Google Fonts family, applied on Enter or when the field loses focus; empty means the bundled font. */
function FontField({ slot, label, value, suggestions, onCommit }: { slot: FontSlot; label: string; value: string; suggestions: string[]; onCommit(v: string): void }) {
  const [draft, setDraft] = useState(value);
  const status = useFontStatus((s) => s[slot]);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft.trim() !== value && onCommit(draft.trim());
  return (
    <Field label={label} hint={`${FONT_STATUS[status]} Any Google Fonts family; leave empty for the built-in font.`}>
      <input
        value={draft}
        list={`font-suggestions-${slot}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        placeholder={slot === 'ui' ? 'Inter (built-in)' : 'JetBrains Mono (built-in)'}
        className={`${INPUT} ${slot === 'ui' ? 'font-sans' : 'font-mono'}`}
      />
      <datalist id={`font-suggestions-${slot}`}>
        {suggestions.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
    </Field>
  );
}

/** A miniature of the app in a theme: its own data-theme, so it shows that theme's colours whatever the current one is. */
function ThemePreview({ theme }: { theme: AppTheme }) {
  return (
    <div data-theme={theme.id} aria-hidden="true" className="h-[92px] flex flex-col rounded-t-[8px] overflow-hidden bg-bg text-fg">
      <div className="flex items-center gap-1 h-4 px-1.5 bg-titlebar border-b border-line">
        <span className="h-2 w-10 rounded-sm bg-panel border border-line" />
        <span className="h-1.5 w-8 rounded-sm bg-chip" />
      </div>
      <div className="flex flex-1 min-h-0">
        <div className="w-[34%] flex flex-col gap-1 p-1.5 bg-side border-r border-line">
          <span className="h-1.5 w-4/5 rounded-sm bg-faint/60" />
          <span className="h-1.5 w-3/5 rounded-sm bg-active" />
          <span className="h-1.5 w-2/3 rounded-sm bg-faint/60" />
          <span className="h-1.5 w-1/2 rounded-sm bg-faint/60" />
        </div>
        <div className="flex-1 flex flex-col gap-[3px] p-1.5 bg-panel">
          <span className="h-2 rounded-sm bg-subtle border border-line" />
          <span className="h-1.5 rounded-sm bg-del-bg" />
          <span className="h-1.5 rounded-sm bg-add-bg" />
          <span className="h-1.5 w-3/4 rounded-sm bg-muted/40" />
          <span className="flex gap-1 mt-auto justify-end">
            <span className="h-2.5 w-6 rounded-sm bg-raised-2 border border-line-2" />
            <span className="h-2.5 w-8 rounded-sm bg-accent" />
          </span>
        </div>
      </div>
    </div>
  );
}

export function ThemePicker({ value, onPick }: { value: string; onPick(theme: AppTheme): void }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-[13px] font-semibold text-strong">Theme</legend>
      <div className="grid grid-cols-2 gap-3">
        {APP_THEMES.map((t) => (
          <label
            key={t.id}
            className={cx('flex flex-col rounded-[10px] border cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent', t.id === value ? 'border-accent ring-1 ring-accent' : 'border-line-2 hover:border-faint')}
          >
            <input type="radio" name="app-theme" value={t.id} checked={t.id === value} onChange={() => onPick(t)} className="sr-only" />
            <ThemePreview theme={t} />
            <span className="flex flex-col gap-0.5 px-3 py-2 border-t border-line-2">
              <span className="font-semibold text-strong">{t.label}</span>
              <span className="text-[12px] text-muted">{t.description}</span>
            </span>
          </label>
        ))}
      </div>
      <span className="text-[12px] text-muted">Picking a theme also switches to its code theme; you can change that below.</span>
    </fieldset>
  );
}

function CodeThemePicker() {
  const { appTheme, codeTheme: theme, diffTint, diffLineHeight, commentFontSize, codeFontSize, uiFont, codeFont } = useAppSettings();
  const appearance = useDiffAppearance();
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const update = (patch: { appTheme?: string; codeTheme?: string; diffTint?: number; diffLineHeight?: number; commentFontSize?: number; codeFontSize?: number; uiFont?: string; codeFont?: string }) => {
    applyAppSettings({ ...useAppSettings.getState(), ...patch });
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void api.getSettings().then((current) => api.saveSettings({ ...current, ...useAppSettings.getState() }));
    }, 300);
  };
  return (
    <div className="flex flex-col gap-2">
      <ThemePicker value={appTheme} onPick={(t) => update({ appTheme: t.id, codeTheme: t.codeTheme })} />
      <Field label="Code theme" hint="Syntax colours for diffs and files. Applies right away to every open tab.">
        <Select value={theme} onChange={(e) => update({ codeTheme: e.target.value })} className="w-[280px]">
          <optgroup label="Dark">
            {DARK_CODE_THEMES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </optgroup>
          <optgroup label="Light">
            {LIGHT_CODE_THEMES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </optgroup>
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <FontField slot="ui" label="Interface font" value={uiFont} suggestions={UI_FONT_SUGGESTIONS} onCommit={(v) => update({ uiFont: v })} />
        <FontField slot="code" label="Code font" value={codeFont} suggestions={CODE_FONT_SUGGESTIONS} onCommit={(v) => update({ codeFont: v })} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Code text size" hint="Diffs, files and code snippets. The default is 13px.">
          <Slider min={11} max={18} value={codeFontSize} unit="px" onChange={(v) => update({ codeFontSize: v })} />
        </Field>
        <Field label="Line height" hint="Spacing between code lines. The default is 20px; it stays at least 4px above the code text size.">
          <Slider min={16} max={28} value={diffLineHeight} unit="px" onChange={(v) => update({ diffLineHeight: v })} />
        </Field>
        <Field label="Changed-line highlight" hint="How strongly added and removed lines are tinted. The diff library's own default is 20%.">
          <Slider min={4} max={30} value={diffTint} unit="%" onChange={(v) => update({ diffTint: v })} />
        </Field>
        <Field label="Comment text size" hint="Review comments, replies and the comment editor. The default is 14px.">
          <Slider min={12} max={18} value={commentFontSize} unit="px" onChange={(v) => update({ commentFontSize: v })} />
        </Field>
      </div>
      <div className="rounded-[9px] border border-line-2 overflow-hidden">
        <MultiFileDiff
          oldFile={PREVIEW_OLD}
          newFile={PREVIEW_NEW}
          options={{ ...appearance, diffStyle: 'unified', disableFileHeader: true, overflow: 'scroll' }}
        />
      </div>
    </div>
  );
}

/** How github.com pull request links get to the app: the browser extension, set up once. */
function OpenFromGitHub() {
  const [info, setInfo] = useState<BrowserExtensionInfo | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    void api.browserExtensionInfo().then(setInfo);
  }, []);
  // Chrome when none is found: still the most likely one.
  const browsers = info?.browsers.length ? info.browsers : [{ name: 'Chrome', page: 'chrome://extensions' }];
  const code = 'font-mono text-[12px] px-1 rounded bg-chip';
  const openPage = async (b: { name: string; page: string }) => {
    await navigator.clipboard.writeText(b.page);
    const opened = await api.openExtensionsPage(b.page);
    setNote(opened ? `Opened ${b.name}. If it didn't show the extensions page, paste ${b.page} (copied) into its address bar.` : `Copied ${b.page}: paste it into ${b.name}'s address bar.`);
  };
  return (
    <section aria-labelledby="from-gh-h" className="flex flex-col gap-2.5 p-3.5 rounded-[10px] border border-line-2 bg-card">
      <h3 id="from-gh-h" className="font-semibold text-strong">
        Open pull requests from GitHub
      </h3>
      <p className="text-[12.5px] text-fg leading-relaxed">
        With the PR Review extension in your browser, GitHub pull request links open here, whether you click them on github.com or open them from Slack, Mail or anywhere else. The browser asks
        &ldquo;Open PR Review?&rdquo; the first time; tick &ldquo;Always allow&rdquo; and it goes straight through. It works in Chrome, Edge and other Chromium browsers.
      </p>
      <ol className="list-decimal pl-5 flex flex-col gap-1.5 text-[12.5px] text-fg leading-relaxed">
        <li>
          Open the extensions page:{' '}
          {browsers.map((b, i) => (
            <span key={b.page}>
              {i > 0 && ' or '}
              <button type="button" onClick={() => void openPage(b)} title={`Open in ${b.name} (the address is also copied)`} className={`${code} text-link hover:underline cursor-pointer`}>
                {b.page}
              </button>
            </span>
          ))}
          , and turn on <strong>Developer mode</strong> (top right).
        </li>
        <li>
          Drag the extension folder from Finder onto that page. Or click <strong>Load unpacked</strong> and pick the folder: it&rsquo;s inside the app, so in the picker press <span className={code}>⇧⌘G</span> and paste its
          path.
        </li>
      </ol>
      {info && (
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate font-mono text-[12px] px-2 py-1 rounded-md bg-chip text-fg" title={info.path}>
            {info.path}
          </code>
          <Button size="sm" onClick={() => void navigator.clipboard.writeText(info.path).then(() => setNote('Copied the folder\'s path.'))}>
            Copy path
          </Button>
          <Button size="sm" onClick={() => void api.revealBrowserExtension()}>
            Show in Finder
          </Button>
        </div>
      )}
      {note && (
        <span role="status" className="text-[12px] text-muted">
          {note}
        </span>
      )}
      <span className="text-[12px] text-muted">
        The extension&rsquo;s toolbar button turns automatic opening on or off, for all repositories or one at a time, and pull request pages get an &ldquo;Open in PR Review&rdquo; button. Links PR Review opens in the browser itself,
        like &ldquo;View on GitHub&rdquo;, stay on GitHub.
      </span>
    </section>
  );
}

export function SignIn({ clientId, onClientId }: { clientId: string; onClientId(id: string): void }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.authStatus().then(setStatus);
  }, []);
  useEffect(() => {
    if (!code) return;
    const timer = setInterval(() => {
      void api.authStatus().then((s) => {
        if (s.via !== 'none') {
          setStatus(s);
          setCode(null);
        }
      });
    }, 3000);
    return () => clearInterval(timer);
  }, [code]);
  if (!status) return <Spinner label="Checking GitHub sign-in…" />;
  return (
    <div className="flex flex-col gap-2 p-3.5 rounded-[10px] border border-line-2 bg-card">
      <span className="font-semibold text-strong">GitHub sign-in</span>
      {status.via !== 'none' ? (
        <div className="flex items-center gap-3 text-[12.5px]">
          <span className="text-fg">
            {status.login ? `Signed in as ${status.login}` : 'Token found'} via {status.via === 'gh' ? 'the GitHub CLI (gh)' : 'device sign-in'}
            {status.error ? ` · ${status.error}` : ''}
          </span>
          {status.via === 'device' && (
            <Button size="sm" onClick={async () => (await api.signOutDevice(), setStatus(await api.authStatus()))}>
              Sign out
            </Button>
          )}
        </div>
      ) : (
        <>
          <span className="text-[12px] text-muted">
            The GitHub CLI isn't signed in. Run <code className="font-mono">gh auth login</code>, or sign in here with your own GitHub OAuth App (device flow enabled).
          </span>
          <div className="flex gap-2">
            <input value={clientId} onChange={(e) => onClientId(e.target.value.trim())} placeholder="OAuth App client ID" className={`${INPUT} flex-1`} />
            <Button
              disabled={!clientId}
              onClick={async () => {
                setError(null);
                try {
                  setCode((await api.deviceLogin()).userCode);
                } catch (err) {
                  setError(errorText(err));
                }
              }}
            >
              Sign in with GitHub
            </Button>
          </div>
          {code && (
            <span className="text-[12.5px] text-fg">
              Enter <span className="font-mono font-bold text-strong">{code}</span> on the GitHub page that just opened. Waiting…
            </span>
          )}
          {error && <ErrorBox message={error} />}
        </>
      )}
    </div>
  );
}

/** The version, and a check against the latest GitHub release. */
function AboutVersion() {
  const { info, checking } = useUpdates();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="sm" disabled={checking} onClick={() => void checkForUpdate()}>
        {checking ? 'Checking…' : 'Check for updates'}
      </Button>
      <span className="text-[12px] text-muted">
        {info ? `PR Review ${info.current}` : 'PR Review'}
        {info?.error ? ` · Couldn't check: ${info.error}` : info?.available ? '' : info?.latest ? ' · the latest version' : ''}
      </span>
      {info?.available && info.url && (
        <button type="button" onClick={() => void api.openExternal(info.url!)} className="text-[12px] text-link hover:underline cursor-pointer">
          Version {info.latest} is available: download
        </button>
      )}
    </div>
  );
}

/** Saves changes to some settings a moment after the last one, over the latest saved settings (each page saves its own). */
function useSettingsSaver() {
  const [s, setS] = useState<Settings | null>(null);
  // The clones found by the last scan, after the folders to look in changed.
  const [found, setFound] = useState<RepoMapping[] | null>(null);
  const setStatus = setSettingsStatus;
  const pending = useRef<Partial<Settings>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void api.getSettings().then(setS);
  }, []);

  const flush = useRef(async () => {
    timer.current = null;
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length === 0) return;
    try {
      const current = await api.getSettings();
      await api.saveSettings({ ...current, ...patch });
      // New folders to scan: find the clones in them now.
      if (patch.scanRoots) setFound(await api.rescanRepos());
      setStatus('Saved');
    } catch (err) {
      setStatus(errorText(err));
    }
  });

  // Leaving the page saves what's still waiting.
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        void flush.current();
      }
    },
    [],
  );

  const set = (patch: Partial<Settings>, wait = 600) => {
    setS((cur) => cur && { ...cur, ...patch });
    pending.current = { ...pending.current, ...patch };
    setStatus('Saving…');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush.current(), wait);
  };
  return { s, set, found };
}

/** A path as you'd write it: your home folder as ~. */
const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');
const lastPart = (p: string) => p.replace(/\/+$/, '').split('/').at(-1) ?? p;
/** A folder short enough for a tree's line: ~ for home, and only its last two folders when it's still long. */
const shortPath = (p: string) => {
  const t = tilde(p).replace(/\/+$/, '');
  return t.length <= 36 ? t : `…/${t.split('/').slice(-2).join('/')}`;
};
const parentOf = (p: string) => p.replace(/\/+$/, '').replace(/\/[^/]+$/, '') || '/';

/** One line of example under a setting: where from, and where to (cut from the left when long). */
function Example({ from, to }: { from: string; to: string }) {
  return (
    <div aria-hidden="true" className="-mt-2 flex items-baseline gap-2 min-w-0 font-mono text-[12px] text-soft">
      <span className="flex-none">{from}</span>
      <span className="text-muted flex-none">→</span>
      <span className="truncate min-w-0" style={{ direction: 'rtl', textAlign: 'left' }}>
        <bdi>{to}</bdi>
      </span>
    </div>
  );
}

/**
 * The repositories the folders above gave, each with its clone: where a pull request of it is checked out from. Shows
 * a folder picked one level off (the clone where the folder holding it was meant, or the other way round) at a glance.
 */
function FoundRepos({ repos }: { repos: RepoMapping[] | null }) {
  if (!repos) return null;
  return (
    <section aria-label="Repositories found" className="-mt-2 flex flex-col gap-1">
      <span className="text-[12px] text-muted">{repos.length === 0 ? 'No clones found in these folders.' : `Found ${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}:`}</span>
      {repos.map((r) => (
        <div key={r.slug} className="flex items-baseline gap-2 min-w-0 text-[12px]">
          <span className="font-mono text-strong flex-none">{r.slug}</span>
          <span className="text-muted flex-none">→</span>
          {/* The end of the path matters most: cut from the left. */}
          <span className="font-mono text-soft truncate min-w-0" style={{ direction: 'rtl' }}>
            <bdi>{r.path}</bdi>
          </span>
          {r.source === 'manual' && <span className="text-muted flex-none">chosen by you</span>}
        </div>
      ))}
    </section>
  );
}

function GeneralPage() {
  const { s, set, found } = useSettingsSaver();
  const [roots, setRoots] = useState<string | null>(null);
  const [repos, setRepos] = useState<RepoMapping[] | null>(null);
  useEffect(() => {
    void api.listRepos().then(setRepos, () => setRepos([]));
  }, []);
  if (!s) return <Spinner label="Loading settings…" />;
  const shown = found ?? repos;
  // The examples use your own folders: the first one listed, and a clone found in it (or any clone).
  const root = s.scanRoots[0] ? shortPath(s.scanRoots[0]) : '~/source';
  const example = (shown ?? []).find((r) => s.scanRoots[0] && tilde(parentOf(r.path)) === tilde(s.scanRoots[0]).replace(/\/+$/, '')) ?? shown?.[0];
  const clone = example?.path;
  const slug = example?.slug;
  return (
    <>
      <Field label="Folders with your clones" hint="One per line: a folder that holds your clones, or a clone itself. Each clone’s remotes tell which repository it is.">
        <textarea
          rows={3}
          value={roots ?? s.scanRoots.join('\n')}
          onChange={(e) => {
            setRoots(e.target.value);
            set({ scanRoots: e.target.value.split('\n').map((r) => r.trim()).filter(Boolean) }, 900);
          }}
          placeholder="~/source"
          className="px-3 py-2 rounded-lg bg-card border border-line-2 focus:border-accent outline-none font-mono text-[12.5px] placeholder:font-sans"
        />
      </Field>
      <Example from={`${root}/`} to={`${root}/${clone ? lastPart(clone) : 'my-app'}`} />
      <FoundRepos repos={shown} />
      <Field label="Worktree folder" hint="Where pull requests are checked out.">
        <input value={s.worktreeRoot ?? ''} onChange={(e) => set({ worktreeRoot: e.target.value.trim() || null })} placeholder="Empty: next to each clone" className={`${INPUT} placeholder:font-sans`} />
      </Field>
      <Example
        from={clone ? shortPath(clone) : '~/source/my-app'}
        to={s.worktreeRoot ? `${shortPath(s.worktreeRoot)}/${slug ?? 'owner/my-app'}/pr-123` : `${clone ? shortPath(clone) : '~/source/my-app'}.worktrees/pr-123`}
      />
      <label className="flex items-center gap-2.5 cursor-pointer text-[13px]">
        <input type="checkbox" checked={s.explainCheckout} onChange={(e) => set({ explainCheckout: e.target.checked }, 0)} style={{ accentColor: 'var(--c-accent)' }} />
        <span>Explain what changes when you switch a pull request between Review and Contribute</span>
      </label>
      <Field label="Editor command" hint="For “Open in Editor”; called as <command> -g file:line (code, cursor, windsurf…).">
        <input value={s.editorCommand} onChange={(e) => set({ editorCommand: e.target.value })} className={INPUT} />
      </Field>
      <div className="flex items-center gap-3 pt-2 border-t border-line">
        <Button size="sm" onClick={() => showSetup(true)}>
          Run setup again
        </Button>
        <span className="text-[12px] text-muted">GitHub sign-in, where your clones are, worktrees, editor and look.</span>
      </div>
    </>
  );
}

function GitHubPage() {
  const { s, set } = useSettingsSaver();
  if (!s) return <Spinner label="Loading settings…" />;
  return (
    <>
      <SignIn clientId={s.oauthClientId} onClientId={(id) => set({ oauthClientId: id }, 300)} />
      <OpenFromGitHub />
    </>
  );
}

function CommentsPage() {
  const { s, set } = useSettingsSaver();
  if (!s) return <Spinner label="Loading settings…" />;
  return (
    <>
      <p className="text-[12.5px] text-fg leading-relaxed">
        When a pull request changes, its comments are placed again in the current code: where the lines they were on went, or by their content when those lines changed. These scores decide how sure that has to be.
        Open pull requests use new values on their next sync.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Re-anchor threshold" hint="Fuzzy score needed to place an outdated comment as “Re-anchored”.">
          <input type="number" step="0.05" min="0" max="1" value={s.placeThreshold} onChange={(e) => set({ placeThreshold: Number(e.target.value) })} className={INPUT} />
        </Field>
        <Field label="Best-guess threshold" hint="Below this a comment shows as “Location lost”.">
          <input type="number" step="0.05" min="0" max="1" value={s.guessThreshold} onChange={(e) => set({ guessThreshold: Number(e.target.value) })} className={INPUT} />
        </Field>
      </div>
      <div className="flex flex-col gap-2 p-3.5 rounded-[10px] border border-line-2 bg-card">
        <label className="flex items-center gap-2.5 cursor-pointer">
          <input type="checkbox" checked={s.aiEnabled} onChange={(e) => set({ aiEnabled: e.target.checked }, 0)} style={{ accentColor: 'var(--c-accent)' }} />
          <span className="font-semibold text-strong">Ask Claude to place low-confidence comments</span>
        </label>
        <span className="text-[12px] text-muted pl-6">
          Off by default. When on, one call to your local Claude Code CLI per sync handles “best guess” and “location lost” threads. Results are labelled “AI-matched” and cached per push.
        </span>
        <label className="flex items-center gap-2 pl-6">
          <span className="text-[12px] text-muted">Model</span>
          <input value={s.aiModel} onChange={(e) => set({ aiModel: e.target.value })} className="h-7 px-2 rounded-md bg-side border border-line-2 font-mono text-[12px] outline-none focus:border-accent" />
        </label>
      </div>
    </>
  );
}

function AboutPage() {
  return (
    <>
      <AboutVersion />
      <p className="text-[12.5px] text-fg leading-relaxed">
        PR Review talks to the GitHub API with your token and to nothing else of its own; there’s no telemetry. The default fonts load from Google Fonts (clear both font fields under Appearance to use the
        bundled ones).
      </p>
      <details className="text-[12px] text-muted">
        <summary className="cursor-pointer w-fit">Acknowledgements</summary>
        <p className="mt-2">
          File and folder icons: <span className="text-fg">Material Icon Theme</span> by Material Extensions, used under the MIT License.
        </p>
        <pre className="mt-2 p-3 rounded-lg bg-card border border-line whitespace-pre-wrap font-mono text-[11px]">{iconLicense}</pre>
        <p className="mt-3">
          Pull request state and status icons: <span className="text-fg">Octicons</span> by GitHub, used under the MIT License.
        </p>
        <pre className="mt-2 p-3 rounded-lg bg-card border border-line whitespace-pre-wrap font-mono text-[11px]">{octiconsLicense}</pre>
        <p className="mt-3">
          Code themes hydra-plus-md and hydra-plus-md-italic: <span className="text-fg">Hydra</span> by juanmnl, used under the MIT License.
        </p>
        <pre className="mt-2 p-3 rounded-lg bg-card border border-line whitespace-pre-wrap font-mono text-[11px]">{hydraLicense}</pre>
      </details>
    </>
  );
}

const SECTIONS: { id: SettingsSection; title: string; desc: string; icon: OcticonName; page: () => React.ReactNode }[] = [
  { id: 'general', title: 'General', desc: 'Where your clones are, where pull requests are checked out, and your editor.', icon: 'file-directory', page: () => <GeneralPage /> },
  { id: 'appearance', title: 'Appearance', desc: 'The app and code themes, fonts and sizes. Changes apply right away to every open tab.', icon: 'paintbrush', page: () => <CodeThemePicker /> },
  { id: 'github', title: 'GitHub', desc: 'Your sign-in, and opening GitHub pull request links in the app.', icon: 'mark-github', page: () => <GitHubPage /> },
  {
    id: 'quick-actions',
    title: 'Quick actions',
    desc: 'Your own commands for a pull request, like asking Claude for a review or running the tests: from the Actions button on its Overview, with ⌥⌘1–9, or from a file’s ⋯ menu.',
    icon: 'zap',
    page: () => <QuickActionsSettings />,
  },
  {
    id: 'agents',
    title: 'Claude',
    desc: 'Claude reviewing with you: one Claude Code session per pull request, for reviews and questions about a line, which also opens in Claude Desktop and Claude Code. Its comments arrive as drafts.',
    icon: 'comment',
    page: () => <AgentsSettings />,
  },
  { id: 'comments', title: 'Comments', desc: 'How review comments are placed again when the code they’re on changes.', icon: 'comment-discussion', page: () => <CommentsPage /> },
  { id: 'about', title: 'About', desc: 'Version and updates, privacy, and the open-source parts inside.', icon: 'info', page: () => <AboutPage /> },
];

/** Settings: a page per section, picked in the sidebar. Everything saves as it changes. */
export function SettingsView() {
  const section = useSettingsPage((s) => s.section);
  const status = useSettingsPage((s) => s.status);
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]!;
  return (
    <div className="h-full flex">
      <nav aria-label="Settings" className="w-[220px] flex-none flex flex-col gap-0.5 px-3 py-5 bg-side border-r border-line overflow-y-auto">
        <h1 className="px-2.5 mb-3 text-[16px] font-semibold text-strong">Settings</h1>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-current={s.id === current.id ? 'page' : undefined}
            onClick={() => showSettingsSection(s.id)}
            className={cx('flex items-center gap-2.5 h-8 px-2.5 rounded-md text-left cursor-pointer', s.id === current.id ? 'bg-active text-strong font-semibold' : 'text-fg hover:bg-hover')}
          >
            <Octicon name={s.icon} size={15} className={s.id === current.id ? 'text-accent' : 'text-muted'} />
            {s.title}
          </button>
        ))}
      </nav>
      <div className="flex-1 min-w-0 overflow-y-auto">
        <section aria-labelledby="settings-h" className="max-w-[820px] mx-auto px-8 pt-6 pb-12 flex flex-col gap-5">
          <header className="flex flex-col gap-1 pb-4 border-b border-line">
            <div className="flex items-baseline gap-3">
              <h2 id="settings-h" className="flex-1 text-[18px] font-semibold text-strong">
                {current.title}
              </h2>
              {status && (
                <span role="status" className={cx('text-[12px]', status === 'Saved' || status === 'Saving…' ? 'text-muted' : 'text-del')}>
                  {status}
                </span>
              )}
            </div>
            <p className="text-[12.5px] text-muted">{current.desc}</p>
          </header>
          {/* Keyed: each page loads the saved settings when it opens. */}
          <div key={current.id} className="flex flex-col gap-5">
            {current.page()}
          </div>
        </section>
      </div>
    </div>
  );
}
