import { useEffect, useSyncExternalStore } from "react";
import type { Registry } from "@fabric/contracts";

import { httpApi } from "@/lib/api";

/**
 * Agent names for "Name · Role" display (D1), over `httpApi.getRegistry` (same validation as web's
 * http.ts). The Weave list must not block on the registry: names fall back to the persona slug and
 * the fetch retries on the next mount until it succeeds.
 */

export type PersonMap = Readonly<Record<string, { name: string; role: string }>>;

const EMPTY: PersonMap = Object.freeze({});

let cache: PersonMap | undefined;
let pending: Promise<void> | undefined;
const listeners = new Set<() => void>();

function set(next: PersonMap) {
  cache = next;
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

function ensure(): Promise<void> {
  if (cache) return Promise.resolve();
  if (pending) return pending;
  const run = (async () => {
    try {
      const registry: Registry = await httpApi.getRegistry();
      const next: Record<string, { name: string; role: string }> = {};
      for (const profile of [...registry.agents, ...registry.communityAgents]) {
        next[profile.agent.id] = { name: profile.agent.name, role: profile.agent.role };
      }
      set(Object.freeze(next));
    } catch (err) {
      console.warn("[weave] registry unreachable, showing persona ids", err);
    } finally {
      pending = undefined;
    }
  })();
  pending = run;
  return run;
}

export function usePeople(): PersonMap {
  useEffect(() => {
    void ensure();
  }, []);
  return useSyncExternalStore(subscribe, () => cache, () => cache) ?? EMPTY;
}

/** "Jonah · Coder"; "you" renders as "You"; unknown ids degrade to a readable slug. */
export function personLabel(agentId: string, people: PersonMap): string {
  const person = people[agentId];
  if (agentId === "you") return "You";
  if (person) return `${person.name} · ${person.role}`;
  return capitalize(agentId);
}

/** Just the name, for inline mentions ("Blocks Implement · Jonah, 12 min"). */
export function personName(agentId: string, people: PersonMap): string {
  const person = people[agentId];
  if (agentId === "you") return "you";
  if (person) return person.name;
  return capitalize(agentId);
}

function capitalize(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}
