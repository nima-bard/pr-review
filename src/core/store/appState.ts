import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RepoMapping, Settings, Version } from '../../shared/model';
import { readJson, writeJson } from './jsonStore';

export const DEFAULT_SETTINGS: Settings = {
  setupDone: false,
  scanRoots: [join(homedir(), 'source')],
  worktreeRoot: null,
  editorCommand: 'code',
  placeThreshold: 0.7,
  guessThreshold: 0.5,
  aiEnabled: false,
  aiModel: 'haiku',
  oauthClientId: '',
  appTheme: 'github-dark',
  codeTheme: 'github-dark-default',
  diffTint: 12,
  diffLineHeight: 20,
  commentFontSize: 14,
  codeFontSize: 13,
  uiFont: 'Mona Sans',
  codeFont: 'JetBrains Mono',
  quickActions: [],
  terminalApp: '',
  mcpPort: 47823,
  // Claude is optional: Settings › Claude turns it on.
  claude: { enabled: false, model: '', effort: '' },
};

export interface ManualPlacement {
  headOid: string;
  path: string;
  line: number;
}

interface AppStateFile {
  settings: Settings;
  repos: RepoMapping[];
  openTabs: string[];
  ownedWorktrees: string[];
}

export class AppState {
  private state: AppStateFile | null = null;

  constructor(private readonly dir: string) {}

  private get file(): string {
    return join(this.dir, 'state.json');
  }

  private async load(): Promise<AppStateFile> {
    if (!this.state) {
      const raw = await readJson<Partial<AppStateFile>>(this.file, {});
      // Settings from before Claude was the app's only agent listed agents; a Claude agent carries over, on, with its model.
      const { agents, agentParallel: _parallel, ...stored } = (raw.settings ?? {}) as Partial<Settings> & { agents?: { kind?: string; model?: string }[]; agentParallel?: unknown };
      const oldClaude = agents?.find((a) => a.kind === 'claude-code' || a.kind === 'claude-terminal');
      // Settings saved before the first-run setup existed come from an install that's already set up.
      const settings = { ...DEFAULT_SETTINGS, ...(raw.settings ? { setupDone: true } : {}), ...stored };
      settings.claude = { ...DEFAULT_SETTINGS.claude, ...(oldClaude ? { enabled: true, model: oldClaude.model ?? '' } : {}), ...stored.claude };
      this.state = {
        settings,
        repos: raw.repos ?? [],
        openTabs: raw.openTabs ?? [],
        ownedWorktrees: raw.ownedWorktrees ?? [],
      };
    }
    return this.state;
  }

  private async save(): Promise<void> {
    if (this.state) await writeJson(this.file, this.state);
  }

  async settings(): Promise<Settings> {
    return (await this.load()).settings;
  }

  async saveSettings(settings: Settings): Promise<void> {
    (await this.load()).settings = settings;
    await this.save();
  }

  async repos(): Promise<RepoMapping[]> {
    return (await this.load()).repos;
  }

  async saveRepos(repos: RepoMapping[]): Promise<void> {
    (await this.load()).repos = repos;
    await this.save();
  }

  async openTabs(): Promise<string[]> {
    return (await this.load()).openTabs;
  }

  async saveOpenTabs(tabs: string[]): Promise<void> {
    (await this.load()).openTabs = tabs;
    await this.save();
  }

  async ownedWorktrees(): Promise<string[]> {
    return (await this.load()).ownedWorktrees;
  }

  async addOwnedWorktree(path: string): Promise<void> {
    const s = await this.load();
    if (!s.ownedWorktrees.includes(path)) s.ownedWorktrees.push(path);
    await this.save();
  }

  async removeOwnedWorktree(path: string): Promise<void> {
    const s = await this.load();
    s.ownedWorktrees = s.ownedWorktrees.filter((p) => p !== path);
    await this.save();
  }

  versionsFile(prKey: string): string {
    return join(this.dir, 'versions', `${safeName(prKey)}.json`);
  }

  async versions(prKey: string): Promise<Version[]> {
    return readJson<Version[]>(this.versionsFile(prKey), []);
  }

  async saveVersions(prKey: string, versions: Version[]): Promise<void> {
    await writeJson(this.versionsFile(prKey), versions);
  }

  private overridesFile(prKey: string): string {
    return join(this.dir, 'placements', `${safeName(prKey)}.json`);
  }

  async placements(prKey: string): Promise<Record<string, ManualPlacement>> {
    return readJson<Record<string, ManualPlacement>>(this.overridesFile(prKey), {});
  }

  async savePlacement(prKey: string, threadId: string, placement: ManualPlacement | null): Promise<void> {
    const all = await this.placements(prKey);
    if (placement) all[threadId] = placement;
    else delete all[threadId];
    await writeJson(this.overridesFile(prKey), all);
  }

  private viewedFile(prKey: string): string {
    return join(this.dir, 'viewed', `${safeName(prKey)}.json`);
  }

  /** path → blob SHA of the file version the user marked as viewed. */
  async viewedBlobs(prKey: string): Promise<Record<string, string>> {
    return readJson<Record<string, string>>(this.viewedFile(prKey), {});
  }

  async saveViewedBlobs(prKey: string, blobs: Record<string, string>): Promise<void> {
    await writeJson(this.viewedFile(prKey), blobs);
  }

  draftsFile(prKey: string): string {
    return join(this.dir, 'drafts', `${safeName(prKey)}.json`);
  }

  summaryFile(prKey: string): string {
    return join(this.dir, 'drafts', `${safeName(prKey)}.summary.json`);
  }
}

export function safeName(key: string): string {
  return key.replace(/[^a-z0-9._-]+/gi, '__');
}
