import { create } from 'zustand';

export type SettingsSection = 'general' | 'appearance' | 'github' | 'quick-actions' | 'comments' | 'about';

/**
 * The Settings page shown, kept while the app runs (Settings opens where you left it), and how its last change saved
 * ("Saving…", "Saved" or an error), shown in the page's header.
 */
export const useSettingsPage = create<{ section: SettingsSection; status: string | null }>(() => ({ section: 'general', status: null }));

export function showSettingsSection(section: SettingsSection): void {
  useSettingsPage.setState({ section, status: null });
}

export function setSettingsStatus(status: string | null): void {
  useSettingsPage.setState({ status });
}
