import { MultiFileDiff } from '@pierre/diffs/react';
import { useEffect, useRef, useState } from 'react';
import type { AuthStatus, Settings } from '../../../shared/model';
import iconLicense from 'material-icon-theme/LICENSE?raw';
import octiconsLicense from '../../components/octicons.LICENSE.txt?raw';
import hydraLicense from '../../diff/hydra/LICENSE.txt?raw';
import { APP_THEMES, DARK_CODE_THEMES, LIGHT_CODE_THEMES, type AppTheme } from '../../../shared/themes';
import { api, errorText } from '../../api';
import { Button, cx, ErrorBox, Select, Spinner } from '../../components/ui';
import { CODE_FONT_SUGGESTIONS, UI_FONT_SUGGESTIONS, useFontStatus, type FontSlot } from '../../state/fonts';
import { applyAppSettings, useAppSettings, useDiffAppearance } from '../../state/settings';
import { showSetup } from '../../state/setup';

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

/** How github.com pull request links get to the app: the Chrome extension, set up once. */
function OpenFromGitHub() {
  return (
    <section aria-labelledby="from-gh-h" className="flex flex-col gap-2 p-3.5 rounded-[10px] border border-line-2 bg-card">
      <h3 id="from-gh-h" className="font-semibold text-strong">
        Open pull requests from GitHub
      </h3>
      <p className="text-[12.5px] text-fg leading-relaxed">
        Like Zoom with meeting links: with the PR Review extension in Chrome, a GitHub pull request link opens here, whether you click it on github.com or open it from Slack, Mail or anywhere else. Chrome asks
        &ldquo;Open PR Review?&rdquo; the first time; tick &ldquo;Always allow&rdquo; and it goes straight through.
      </p>
      <ol className="list-decimal pl-5 text-[12.5px] text-fg leading-relaxed">
        <li>
          In Chrome, open <code className="font-mono text-[12px] px-1 rounded bg-chip">chrome://extensions</code> and turn on Developer mode.
        </li>
        <li>Click Load unpacked and pick the extension folder.</li>
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={() => void api.revealBrowserExtension()}>
          Show extension folder
        </Button>
        <span className="text-[12px] text-muted">Its toolbar button turns automatic opening on or off, for all repositories or one at a time. Links PR Review opens in the browser itself, like &ldquo;View on GitHub&rdquo;, stay on GitHub.</span>
      </div>
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

export function SettingsView() {
  const [s, setS] = useState<Settings | null>(null);
  const [roots, setRoots] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.getSettings().then((v) => {
      setS(v);
      setRoots(v.scanRoots.join('\n'));
    });
  }, []);

  if (!s) return <Spinner label="Loading settings…" />;
  const set = (patch: Partial<Settings>) => {
    setS({ ...s, ...patch });
    setSaved(false);
  };

  const save = async () => {
    setError(null);
    try {
      const { appTheme, codeTheme, diffTint, diffLineHeight, commentFontSize, codeFontSize, uiFont, codeFont } = useAppSettings.getState();
      const next = { ...s, appTheme, codeTheme, diffTint, diffLineHeight, commentFontSize, codeFontSize, uiFont, codeFont, scanRoots: roots.split('\n').map((r) => r.trim()).filter(Boolean) };
      await api.saveSettings(next);
      applyAppSettings(next);
      await api.rescanRepos();
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section aria-label="Settings" className="max-w-[720px] flex flex-col gap-5">
      <SignIn
        clientId={s.oauthClientId}
        onClientId={(id) => {
          set({ oauthClientId: id });
          void api.saveSettings({ ...s, ...useAppSettings.getState(), oauthClientId: id });
        }}
      />
      <CodeThemePicker />
      <OpenFromGitHub />
      <Field label="Folders to scan for clones" hint="One per line. Each folder's direct subfolders are checked for git clones; their remotes map owner/repo to the clone.">
        <textarea rows={3} value={roots} onChange={(e) => (setRoots(e.target.value), setSaved(false))} className="px-3 py-2 rounded-lg bg-card border border-line-2 focus:border-accent outline-none font-mono text-[12.5px]" />
      </Field>
      <Field label="Worktree folder" hint="Empty: next to the clone, e.g. ~/source/my-app.worktrees/pr-123. Set a folder to use <folder>/wt-pr-123 instead.">
        <input value={s.worktreeRoot ?? ''} onChange={(e) => set({ worktreeRoot: e.target.value.trim() || null })} placeholder="(next to the clone)" className={INPUT} />
      </Field>
      <Field label="Editor command" hint="Used for “Open in editor”; called as <command> -g file:line (code, cursor, windsurf…).">
        <input value={s.editorCommand} onChange={(e) => set({ editorCommand: e.target.value })} className={INPUT} />
      </Field>
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
          <input type="checkbox" checked={s.aiEnabled} onChange={(e) => set({ aiEnabled: e.target.checked })} style={{ accentColor: 'var(--c-accent)' }} />
          <span className="font-semibold text-strong">Ask Claude to place low-confidence comments</span>
        </label>
        <span className="text-[12px] text-muted pl-6">
          Off by default. When on, one call to your local Claude Code CLI per refresh handles “best guess” and “location lost” threads. Results are labelled “AI-matched” and cached per push.
        </span>
        <label className="flex items-center gap-2 pl-6">
          <span className="text-[12px] text-muted">Model</span>
          <input value={s.aiModel} onChange={(e) => set({ aiModel: e.target.value })} className="h-7 px-2 rounded-md bg-side border border-line-2 font-mono text-[12px] outline-none focus:border-accent" />
        </label>
      </div>
      {error && <ErrorBox message={error} />}
      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={() => void save()}>
          Save settings
        </Button>
        {saved && <span className="text-add text-[12.5px]">Saved. Open pull requests pick up threshold changes on their next refresh.</span>}
      </div>
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={() => showSetup(true)}>
          Run setup again
        </Button>
        <span className="text-[12px] text-muted">GitHub sign-in, where your clones are, worktrees, editor and look.</span>
      </div>
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
    </section>
  );
}
