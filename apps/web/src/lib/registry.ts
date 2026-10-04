import { useSyncExternalStore } from "react";
import type { ChatAgent, Organization, Project, Registry, Run, Session, StudioProfile, Task } from "@fabric/contracts";

const empty: Registry = { agents: [], communityAgents: [], teams: [], communityTeams: [], organizations: [], projects: [], sessions: [], personaPool: [] };
let current: Registry = empty;
let tasks: Task[] = [];
let runs: Run[] = [];
let version = 0;
const listeners = new Set<() => void>();
const notify = () => { version++; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };

export function useRegistry() { useSyncExternalStore(subscribe, () => version); return current; }
export function setRegistry(value: Registry) { current = value; notify(); }
export function setWorkData(nextTasks: Task[], nextRuns: Run[]) { tasks = nextTasks; runs = nextRuns; notify(); }
export function setProjects(projects: Project[]) { current = { ...current, projects }; notify(); }

export const registry = () => current;
export const profileById = (id: string): StudioProfile => [...current.agents, ...current.communityAgents].find((p) => p.agent.id === id)!;
export const myProfiles = () => current.agents;
export const communityProfiles = () => current.communityAgents;
export const studioTeams = () => current.teams;
export const communityTeams = () => current.communityTeams;
export const organizations = (): Organization[] => current.organizations;
export const projects = (): Project[] => current.projects;
export const sessions = (): Session[] => current.sessions;
export const chatAgents = (): ChatAgent[] => ["dana", "jonah", "megan", "carlos"].map((id) => current.agents.find((p) => p.agent.id === id)?.agent).filter((a): a is ChatAgent => !!a);
export const workTasks = () => tasks;
export const workRuns = () => runs;
