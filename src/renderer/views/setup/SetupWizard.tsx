import { useEffect, useState, type ReactNode } from 'react';
import type { RepoMapping, Settings, SetupInfo } from '../../../shared/model';
import { api, errorText } from '../../api';
import { Button, cx, ErrorBox, Icon, Kbd, Select, Spinner } from '../../components/ui';
import { refreshInbox } from '../../state/inbox';
import { applyAppSettings, useAppSettings } from '../../state/settings';
import { showSetup } from '../../state/setup';
import { Field, INPUT, SignIn, ThemePicker } from '../newtab/SettingsView';

const STEPS = ['Welcome', 'GitHub', 'Repositories', 'Worktrees & editor', 'Look', 'Done'] as const;

/** A requirement on the welcome page: found (with its version) or not (with how to get it). */
function Check({ ok, label, detail, fix }: { ok: boolean; label: string; detail: string | null; fix: ReactNode }) {
  return (
    <div className="flex gap-3 items-start px-3.5 py-3 rounded-[10px] border border-line-2 bg-card">
      <span className={cx('mt-0.5', ok ? 'text-add' : 'text-warn')}>
        <Icon name={ok ? 'check' : 'info'} size={15} />
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="font-semibold text-strong">{label}</span>
        <span className="text-[12.5px] text-muted">{ok ? detail : fix}</span>
      </span>
    </div>
  );
}

const Code = ({ children }: { children: ReactNode }) => <code className="font-mono text-[12px] px-1 rounded bg-chip text-fg">{children}</code>;

/**
 * First run on a machine: checks for git and the GitHub CLI, signs in, finds the folders with your clones, and picks
 * where worktrees go, the editor and a theme. Every step saves as it goes; it can be skipped, and run again from
 * Settings.
 */
export function SetupWizard() {
  const [step, setStep] = useState(0);
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [repos, setRepos] = useState<RepoMapping[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signInKey, setSignInKey] = useState(0);
  const appTheme = useAppSettings((s) => s.appTheme);

  useEffect(() => {
    void Promise.all([api.setupInfo(), api.getSettings()]).then(([found, saved]) => {
      setInfo(found);
      setSettings(saved);
      // Start from the folders that hold clones, plus any saved ones that still exist among them.
      setRoots([...new Set([...found.folders.map((f) => f.path), ...saved.scanRoots.filter((r) => found.folders.some((f) => f.path === r))])]);
    });
  }, []);

  /** Saves a change on top of the current settings (and the appearance settings, which live in their own store). */
  const save = async (patch: Partial<Settings>) => {
    const next = { ...(await api.getSettings()), ...useAppSettings.getState(), ...patch };
    await api.saveSettings(next);
    setSettings(next);
    return next;
  };

  const finish = async () => {
    await save({ setupDone: true });
    showSetup(false);
    void refreshInbox(true);
  };

  const scan = async () => {
    setScanning(true);
    setError(null);
    try {
      await save({ scanRoots: roots });
      setRepos(await api.rescanRepos());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setScanning(false);
    }
  };

  if (!info || !settings) {
    return (
      <div className="h-full grid place-items-center">
        <Spinner label="Looking around this Mac…" />
      </div>
    );
  }

  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));
  const editorKnown = info.editors.some((e) => e.command === settings.editorCommand);

  return (
    <div className="h-full flex flex-col bg-bg">
      {/* The title bar area: drag the window here (the traffic lights sit on the left). */}
      <div className="drag h-[42px] flex-none bg-titlebar border-b border-line" />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[880px] mx-auto px-6 py-10 grid grid-cols-[180px_1fr] gap-10">
          <ol aria-label="Setup steps" className="flex flex-col gap-1 pt-1">
            {STEPS.map((label, i) => (
              <li key={label}>
                <button
                  type="button"
                  aria-current={i === step ? 'step' : undefined}
                  onClick={() => setStep(i)}
                  className={cx('flex items-center gap-2.5 w-full h-8 px-2.5 rounded-md text-left cursor-pointer', i === step ? 'bg-active text-strong font-semibold' : 'text-muted hover:text-fg')}
                >
                  <span className={cx('grid place-items-center w-5 h-5 rounded-full text-[11px] font-semibold flex-none', i < step ? 'bg-add-bg text-add' : i === step ? 'bg-accent text-ink' : 'bg-chip text-soft')}>
                    {i < step ? <Icon name="check" size={11} /> : i + 1}
                  </span>
                  {label}
                </button>
              </li>
            ))}
          </ol>

          <section aria-labelledby="setup-h" className="flex flex-col gap-5 min-w-0">
            {step === 0 && (
              <>
                <h1 id="setup-h" className="text-[24px] font-bold text-strong tracking-tight">
                  Welcome to PR Review
                </h1>
                <p className="text-fg leading-relaxed">
                  Review GitHub pull requests in your own checkout. Each pull request opens in a git worktree next to your clone, comments follow the code as it changes, and your review stays on this Mac until you
                  submit it. A few questions and you&rsquo;re set; you can change everything later in Settings (<Kbd>⌘,</Kbd>).
                </p>
                <div className="flex flex-col gap-2.5">
                  <Check ok={info.git !== null} label="git" detail={info.git} fix={<>PR Review needs git. Install Apple&rsquo;s command line tools with <Code>xcode-select --install</Code>, then restart PR Review.</>} />
                  <Check
                    ok={info.gh !== null}
                    label="GitHub CLI"
                    detail={info.gh}
                    fix={<>Not installed. It&rsquo;s the easiest way to sign in: <Code>brew install gh</Code>, then <Code>gh auth login</Code>. Signing in with a GitHub OAuth app works too.</>}
                  />
                </div>
              </>
            )}

            {step === 1 && (
              <>
                <h1 id="setup-h" className="text-[24px] font-bold text-strong tracking-tight">
                  Sign in to GitHub
                </h1>
                <p className="text-fg leading-relaxed">
                  PR Review uses your GitHub CLI login. Signed in with <Code>gh auth login</Code> already? Then there&rsquo;s nothing to do. Your token stays with gh (an OAuth sign-in&rsquo;s token is saved encrypted, with a key kept in your
                  macOS keychain) and only goes to GitHub.
                </p>
                <SignIn key={signInKey} clientId={settings.oauthClientId} onClientId={(id) => void save({ oauthClientId: id })} />
                <div>
                  <Button size="sm" onClick={() => setSignInKey((k) => k + 1)}>
                    <Icon name="refresh" size={12} /> Check again
                  </Button>
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <h1 id="setup-h" className="text-[24px] font-bold text-strong tracking-tight">
                  Where are your repositories?
                </h1>
                <p className="text-fg leading-relaxed">
                  Pick the folders that hold your clones. PR Review looks at the folders directly inside them and matches each clone to its GitHub repository, so a pull request opens in the right one. A repository
                  that isn&rsquo;t found asks for its folder the first time you open one of its pull requests.
                </p>
                <div className="flex flex-col gap-1.5">
                  {[...new Set([...info.folders.map((f) => f.path), ...roots])].map((path) => {
                    const known = info.folders.find((f) => f.path === path);
                    const on = roots.includes(path);
                    return (
                      <label key={path} className="flex items-center gap-3 px-3.5 py-2.5 rounded-[10px] border border-line-2 bg-card cursor-pointer">
                        <input type="checkbox" checked={on} onChange={() => setRoots(on ? roots.filter((r) => r !== path) : [...roots, path])} style={{ accentColor: 'var(--c-accent)' }} />
                        <span className="flex-1 font-mono text-[12.5px] text-fg truncate">{path.replace(info.home, '~')}</span>
                        {known && <span className="text-[12px] text-muted">{known.repos} clone{known.repos === 1 ? '' : 's'}</span>}
                      </label>
                    );
                  })}
                  {info.folders.length === 0 && roots.length === 0 && <div className="text-muted text-[12.5px]">No folders with clones found in the usual places. Add yours:</div>}
                </div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <Button
                    onClick={async () => {
                      const dir = await api.pickFolder('Choose a folder that holds your clones');
                      if (dir && !roots.includes(dir)) setRoots([...roots, dir]);
                    }}
                  >
                    <Icon name="plus" size={13} /> Add folder…
                  </Button>
                  <Button disabled={roots.length === 0 || scanning} onClick={() => void scan()}>
                    {scanning ? 'Looking…' : 'Find repositories'}
                  </Button>
                  {repos && (
                    <span className="text-[12.5px] text-muted">
                      Found {repos.length} repositor{repos.length === 1 ? 'y' : 'ies'}
                      {repos.length > 0 ? `: ${repos.slice(0, 6).map((r) => r.slug).join(', ')}${repos.length > 6 ? ', …' : ''}` : ''}
                    </span>
                  )}
                </div>
                {error && <ErrorBox message={error} />}
              </>
            )}

            {step === 3 && (
              <>
                <h1 id="setup-h" className="text-[24px] font-bold text-strong tracking-tight">
                  Worktrees and editor
                </h1>
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-2 text-[13px] font-semibold text-strong">Where pull requests are checked out</legend>
                  <label className="flex gap-2.5 items-start cursor-pointer">
                    <input type="radio" name="wt" checked={settings.worktreeRoot === null} onChange={() => void save({ worktreeRoot: null })} className="mt-1" style={{ accentColor: 'var(--c-accent)' }} />
                    <span>
                      Next to each clone
                      <span className="block text-[12px] text-muted font-mono">~/source/my-app → ~/source/my-app.worktrees/pr-123</span>
                    </span>
                  </label>
                  <label className="flex gap-2.5 items-start cursor-pointer">
                    <input
                      type="radio"
                      name="wt"
                      checked={settings.worktreeRoot !== null}
                      onChange={async () => {
                        const dir = await api.pickFolder('Choose a folder for pull request worktrees');
                        if (dir) void save({ worktreeRoot: dir });
                      }}
                      className="mt-1"
                      style={{ accentColor: 'var(--c-accent)' }}
                    />
                    <span>
                      In one folder{settings.worktreeRoot ? ': ' : ''}
                      {settings.worktreeRoot && <span className="font-mono text-[12.5px]">{settings.worktreeRoot.replace(info.home, '~')}</span>}
                      <span className="block text-[12px] text-muted font-mono">&lt;folder&gt;/wt-pr-123</span>
                    </span>
                  </label>
                </fieldset>
                <Field label="Editor" hint={'"Open in editor" opens files at the line in it. Any VS Code-style command works (it gets -g file:line).'}>
                  <span className="flex flex-wrap gap-2">
                    {info.editors.length > 0 && (
                      <Select value={editorKnown ? settings.editorCommand : ''} onChange={(e) => e.target.value && void save({ editorCommand: e.target.value })} className="w-[260px]">
                        <option value="">Other…</option>
                        {info.editors.map((e) => (
                          <option key={e.command} value={e.command}>
                            {e.label}
                          </option>
                        ))}
                      </Select>
                    )}
                    {(!editorKnown || info.editors.length === 0) && (
                      <input defaultValue={settings.editorCommand} onBlur={(e) => void save({ editorCommand: e.target.value.trim() || 'code' })} placeholder="code" className={`${INPUT} w-[260px]`} />
                    )}
                  </span>
                </Field>
              </>
            )}

            {step === 4 && (
              <>
                <h1 id="setup-h" className="text-[24px] font-bold text-strong tracking-tight">
                  Pick a look
                </h1>
                <ThemePicker
                  value={appTheme}
                  onPick={(t) => {
                    applyAppSettings({ ...useAppSettings.getState(), appTheme: t.id, codeTheme: t.codeTheme });
                    void save({ appTheme: t.id, codeTheme: t.codeTheme });
                  }}
                />
              </>
            )}

            {step === 5 && (
              <>
                <h1 id="setup-h" className="text-[24px] font-bold text-strong tracking-tight">
                  You&rsquo;re set
                </h1>
                <ul className="flex flex-col gap-2.5 text-fg leading-relaxed list-disc pl-5">
                  <li>
                    Open a pull request by pasting its link into a new tab (<Kbd>⌘T</Kbd>), or pick one from <em>For you</em>.
                  </li>
                  <li>
                    <Kbd>⇧⌘F</Kbd> searches the pull request&rsquo;s code, <Kbd>?</Kbd> lists the shortcuts.
                  </li>
                  <li>
                    Want GitHub links to open here? Add the browser extension: Settings › Open pull requests from GitHub.{' '}
                    <button type="button" onClick={() => void api.revealBrowserExtension()} className="text-link hover:underline cursor-pointer">
                      Show its folder
                    </button>
                  </li>
                </ul>
              </>
            )}

            <div className="flex items-center gap-2.5 pt-4 mt-2 border-t border-line">
              {step < STEPS.length - 1 && (
                <button type="button" onClick={() => void finish()} className="text-[12.5px] text-muted hover:text-fg cursor-pointer">
                  Skip setup
                </button>
              )}
              <span className="flex-1" />
              {step > 0 && <Button onClick={() => setStep(step - 1)}>Back</Button>}
              {step === 2 && repos === null && roots.length > 0 ? (
                <Button variant="primary" disabled={scanning} onClick={async () => (await scan(), next())}>
                  Find repositories and continue
                </Button>
              ) : step < STEPS.length - 1 ? (
                <Button variant="primary" onClick={next}>
                  Continue
                </Button>
              ) : (
                <Button variant="primary" onClick={() => void finish()}>
                  Start reviewing
                </Button>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
