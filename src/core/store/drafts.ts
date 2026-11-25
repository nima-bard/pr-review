import type { Draft } from '../../shared/model';
import { readJson, writeJson } from './jsonStore';

export class DraftStore {
  constructor(private readonly fileFor: (prKey: string) => string) {}

  list(prKey: string): Promise<Draft[]> {
    return readJson<Draft[]>(this.fileFor(prKey), []);
  }

  async save(prKey: string, draft: Draft): Promise<void> {
    const drafts = await this.list(prKey);
    const idx = drafts.findIndex((d) => d.id === draft.id);
    if (idx === -1) drafts.push(draft);
    else drafts[idx] = draft;
    await writeJson(this.fileFor(prKey), drafts);
  }

  async saveAll(prKey: string, drafts: Draft[]): Promise<void> {
    await writeJson(this.fileFor(prKey), drafts);
  }

  async remove(prKey: string, draftId: string): Promise<void> {
    const drafts = await this.list(prKey);
    await writeJson(
      this.fileFor(prKey),
      drafts.filter((d) => d.id !== draftId),
    );
  }

  async markPosted(prKey: string, draftId: string, threadId: string): Promise<void> {
    const drafts = await this.list(prKey);
    const d = drafts.find((x) => x.id === draftId);
    if (d) d.postedThreadId = threadId;
    await writeJson(this.fileFor(prKey), drafts);
  }

  async clear(prKey: string): Promise<void> {
    await writeJson(this.fileFor(prKey), []);
  }
}
