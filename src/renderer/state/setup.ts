import { create } from 'zustand';

/** Whether the first-run setup shows (null until the settings are loaded). Settings can bring it back. */
export const useSetup = create<{ show: boolean | null }>(() => ({ show: null }));

export function showSetup(show: boolean): void {
  useSetup.setState({ show });
}
