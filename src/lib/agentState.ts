import type { AgentStateMemoryEntry, AgentStateSnapshot } from './types.ts';

type StateSubscriber = (value: unknown, key: string) => void;

/**
 * Lightweight reactive key-value + session memory store shared between
 * EM-3 ProjectProgressTracker and UnifiedRouterService.
 */
export class AgentStateStore {
  private values = new Map<string, unknown>();
  private subscribers = new Map<string, Set<StateSubscriber>>();
  private memoryLog: AgentStateMemoryEntry[] = [];

  constructor(initial?: Partial<AgentStateSnapshot>) {
    if (initial) {
      this.loadSnapshot(initial);
    }
  }

  get<T = unknown>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  set<T = unknown>(key: string, value: T): void {
    this.values.set(key, value);
    const exact = this.subscribers.get(key);
    if (exact) {
      for (const cb of exact) {
        cb(value, key);
      }
    }
    const wildcard = this.subscribers.get('*');
    if (wildcard) {
      for (const cb of wildcard) {
        cb(value, key);
      }
    }
  }

  subscribe(key: string, callback: StateSubscriber): () => void {
    let set = this.subscribers.get(key);
    if (!set) {
      set = new Set<StateSubscriber>();
      this.subscribers.set(key, set);
    }
    set.add(callback);
    return () => {
      set?.delete(callback);
    };
  }

  appendMemory(entry: Omit<AgentStateMemoryEntry, 'id' | 'timestamp'>): AgentStateMemoryEntry {
    const fullEntry: AgentStateMemoryEntry = {
      id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.memoryLog.unshift(fullEntry);
    if (this.memoryLog.length > 50) {
      this.memoryLog.length = 50;
    }
    this.set('sessionMemoryLog', [...this.memoryLog]);
    return fullEntry;
  }

  getMemoryLog(): AgentStateMemoryEntry[] {
    return [...this.memoryLog];
  }

  getSnapshot(): AgentStateSnapshot {
    const rawValues: Record<string, unknown> = {};
    for (const [k, v] of this.values.entries()) {
      if (k !== 'sessionMemoryLog') {
        rawValues[k] = v;
      }
    }
    return {
      currentFocusId: (this.values.get('currentFocusId') as string | null) ?? null,
      routeOverride: (this.values.get('routeOverride') as string | null) ?? null,
      lastCompletedMilestoneId:
        (this.values.get('lastCompletedMilestoneId') as string | null) ?? null,
      sessionMemoryLog: [...this.memoryLog],
      values: rawValues,
    };
  }

  loadSnapshot(snapshot: Partial<AgentStateSnapshot>): void {
    this.values.clear();
    if (snapshot.values) {
      for (const [k, v] of Object.entries(snapshot.values)) {
        this.values.set(k, v);
      }
    }
    if (snapshot.currentFocusId !== undefined) {
      this.values.set('currentFocusId', snapshot.currentFocusId);
    }
    if (snapshot.routeOverride !== undefined) {
      this.values.set('routeOverride', snapshot.routeOverride);
    }
    if (snapshot.lastCompletedMilestoneId !== undefined) {
      this.values.set('lastCompletedMilestoneId', snapshot.lastCompletedMilestoneId);
    }
    this.memoryLog = Array.isArray(snapshot.sessionMemoryLog)
      ? [...snapshot.sessionMemoryLog].slice(0, 50)
      : [];
    this.values.set('sessionMemoryLog', [...this.memoryLog]);
  }

  reset(): void {
    this.values.clear();
    this.memoryLog = [];
    this.set('currentFocusId', null);
    this.set('routeOverride', null);
    this.set('lastCompletedMilestoneId', null);
  }
}
