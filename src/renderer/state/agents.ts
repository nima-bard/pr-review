import { create } from 'zustand';
import type { AgentConnector, AgentRequest } from '../../shared/model';
import { api, errorText } from '../api';
import { setSessionError, useSessions } from './sessions';
import { updateUi } from './ui';

/** The agents from Settings › Agents, kept here for the composer, the Review button and the Agent panel. */
export const useAgents = create<{ agents: AgentConnector[] }>(() => ({ agents: [] }));

export async function loadAgents(): Promise<void> {
  const settings = await api.getSettings();
  useAgents.setState({ agents: settings.agents });
}

export function setAgents(agents: AgentConnector[]): void {
  useAgents.setState({ agents });
}

/** The agent PR `key` talks to: its session's connector, or the default (the first); undefined when none is set up. */
export function useAgentFor(key: string): AgentConnector | undefined {
  const agents = useAgents((s) => s.agents);
  const connectorId = useSessions((s) => s.agents[key]?.connectorId);
  return agents.find((a) => a.id === connectorId) ?? agents[0];
}

/** The same, outside React (menus). */
export function agentFor(key: string): AgentConnector | undefined {
  const { agents } = useAgents.getState();
  const connectorId = useSessions.getState().agents[key]?.connectorId;
  return agents.find((a) => a.id === connectorId) ?? agents[0];
}

/** Sends a request to the PR's agent and shows the Agent panel; a failure shows on the PR. */
export async function askAgent(key: string, request: AgentRequest, showPanel = true): Promise<void> {
  try {
    await api.askAgent(key, request);
    if (showPanel) updateUi(key, { showAgent: true });
  } catch (err) {
    setSessionError(key, errorText(err));
  }
}
