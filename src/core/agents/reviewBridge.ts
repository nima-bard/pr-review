import type { DiffSide, Draft, DraftOrigin, FileDiffModel, PrSnapshot } from '../../shared/model';

export interface AgentDraftInput {
  path: string;
  side: DiffSide;
  line: number;
  startLine: number | null;
  body: string;
}

/** What the MCP tools may do in the app: read open PRs and manage drafts, nothing on GitHub. */
export interface ReviewBridge {
  openPrs(): { key: string; url: string; title: string; worktree: string }[];
  /** Accepts a key, a URL or owner/repo#n; throws "Open … in PR Review first." when it isn't open or still loading. */
  snapshot(pr: string): PrSnapshot;
  fileDiff(pr: string, path: string): Promise<FileDiffModel | null>;
  addDraft(pr: string, input: AgentDraftInput, origin: DraftOrigin): Promise<Draft>;
  updateDraft(pr: string, id: string, body: string): Promise<Draft>;
  deleteDraft(pr: string, id: string): Promise<void>;
}
