import type { ViewedFailure } from '../github/reviews';
import type { CodeSearchQuery, CodeSearchResult, DiffSide, Draft, DraftOrigin, FileDiffModel, PrSnapshot, RevealTarget } from '../../shared/model';

export interface AgentDraftInput {
  path: string;
  side: DiffSide;
  line: number;
  startLine: number | null;
  body: string;
}

/**
 * What the MCP tools may do in the app: read open PRs, manage drafts, search the code, mark files viewed and show
 * things in the PR's tab. Nothing that other people see on GitHub.
 */
export interface ReviewBridge {
  openPrs(): { key: string; url: string; title: string; worktree: string }[];
  /** Accepts a key, a URL or owner/repo#n; throws "Open … in PR Review first." when it isn't open or still loading. */
  snapshot(pr: string): PrSnapshot;
  fileDiff(pr: string, path: string): Promise<FileDiffModel | null>;
  addDraft(pr: string, input: AgentDraftInput, origin: DraftOrigin): Promise<Draft>;
  updateDraft(pr: string, id: string, body: string): Promise<Draft>;
  deleteDraft(pr: string, id: string): Promise<void>;
  /** The user's Viewed checkboxes (GitHub keeps them for the user only); returns the files GitHub refused. */
  setViewed(pr: string, paths: string[], viewed: boolean): Promise<ViewedFailure[]>;
  searchCode(pr: string, query: CodeSearchQuery): Promise<CodeSearchResult>;
  /** Every file in the PR head, for showing one the PR doesn't change. */
  allFiles(pr: string): Promise<string[]>;
  /** Shows `target` in the PR's tab and brings its window to the front. */
  reveal(pr: string, target: RevealTarget): void;
}
