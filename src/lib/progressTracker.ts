import type { AgentStateStore } from './agentState.ts';
import { cosineSimilarity } from './routerEngine.ts';
import type {
  MilestoneProgress,
  ProjectMilestone,
  ProjectProgressState,
} from './types.ts';

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

export interface ProgressTrackerOptions {
  sessionId?: string;
  embedStateTexts: (texts: string[]) => Promise<number[][]>;
  agentState?: AgentStateStore;
  onMilestoneCrossed?: (milestone: ProjectMilestone, progress: MilestoneProgress) => void;
}

/**
 * Tracks continuous project milestone alignment via EM-3 (BAAI/bge-m3 1024-dim state space).
 * Pre-embeds milestone descriptions and evaluates each LLM/tool output to compute
 * per-milestone completion scores, active focus, and optional next-step route overrides.
 */
export class ProjectProgressTracker {
  private state: ProjectProgressState;
  private readonly embedStateTexts: (texts: string[]) => Promise<number[][]>;
  private readonly agentState?: AgentStateStore;
  private readonly onMilestoneCrossed?: (
    milestone: ProjectMilestone,
    progress: MilestoneProgress
  ) => void;

  constructor(opts: ProgressTrackerOptions) {
    this.embedStateTexts = opts.embedStateTexts;
    this.agentState = opts.agentState;
    this.onMilestoneCrossed = opts.onMilestoneCrossed;
    this.state = {
      sessionId: opts.sessionId ?? `sess-${Date.now().toString(36)}`,
      milestones: [],
      progress: [],
      overallProgress: 0,
      currentFocusId: null,
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  getState(): ProjectProgressState {
    return structuredClone(this.state);
  }

  restoreState(saved: ProjectProgressState): void {
    this.state = structuredClone(saved);
    this.agentState?.set('currentFocusId', this.state.currentFocusId);
  }

  async setMilestones(milestones: ProjectMilestone[]): Promise<ProjectProgressState> {
    const clean = milestones.map((m) => ({
      id: m.id,
      label: m.label.trim() || 'Untitled Milestone',
      description: m.description.trim() || m.label.trim(),
      completionThreshold: Math.max(0.1, Math.min(0.99, m.completionThreshold || 0.85)),
      targetRouteHint: m.targetRouteHint?.trim() || undefined,
      embeddingVec: m.embeddingVec,
    }));

    const missing = clean.filter((m) => !m.embeddingVec || m.embeddingVec.length === 0);
    if (missing.length > 0) {
      const vecs = await this.embedStateTexts(missing.map((m) => m.description));
      missing.forEach((m, idx) => {
        m.embeddingVec = vecs[idx] ?? [];
      });
    }

    const prevMap = new Map(this.state.progress.map((p) => [p.milestoneId, p]));
    const nextProgress: MilestoneProgress[] = clean.map((m) => {
      const existing = prevMap.get(m.id);
      return existing
        ? { ...existing, label: m.label }
        : {
            milestoneId: m.id,
            label: m.label,
            score: 0,
            completed: false,
          };
    });

    const overall =
      nextProgress.length > 0
        ? round4(nextProgress.reduce((acc, p) => acc + p.score, 0) / nextProgress.length)
        : 0;

    const focusCandidate =
      nextProgress.find((p) => !p.completed)?.milestoneId ?? nextProgress[0]?.milestoneId ?? null;

    this.state = {
      ...this.state,
      milestones: clean,
      progress: nextProgress,
      overallProgress: overall,
      currentFocusId: focusCandidate,
      lastUpdatedAt: new Date().toISOString(),
    };

    this.agentState?.set('currentFocusId', this.state.currentFocusId);
    return this.getState();
  }

  async ensureMilestonesEmbedded(): Promise<void> {
    const needsEmbed = this.state.milestones.some(
      (m) => !m.embeddingVec || m.embeddingVec.length === 0
    );
    if (needsEmbed) {
      await this.setMilestones(this.state.milestones);
    }
  }

  async updateProgress(outputText: string): Promise<{
    state: ProjectProgressState;
    newlyCompleted: MilestoneProgress[];
    autoAdvanceRoute: string | null;
  }> {
    const trimmed = outputText.trim();
    if (!trimmed) {
      return {
        state: this.getState(),
        newlyCompleted: [],
        autoAdvanceRoute: null,
      };
    }

    await this.ensureMilestonesEmbedded();

    const [outputVec] = await this.embedStateTexts([trimmed]);
    const nowIso = new Date().toISOString();
    const prevMap = new Map(this.state.progress.map((p) => [p.milestoneId, p]));

    const newlyCompleted: MilestoneProgress[] = [];
    let autoAdvanceRoute: string | null = null;

    const nextProgress: MilestoneProgress[] = this.state.milestones.map((milestone) => {
      const prev = prevMap.get(milestone.id);
      const sim = round4(cosineSimilarity(outputVec ?? [], milestone.embeddingVec ?? []));
      const bestScore = prev?.completed ? Math.max(prev.score, sim) : sim;
      const crossedNow = !prev?.completed && sim >= milestone.completionThreshold;
      const completed = Boolean(prev?.completed) || crossedNow;

      const entry: MilestoneProgress = {
        milestoneId: milestone.id,
        label: milestone.label,
        score: bestScore,
        completed,
        completedAt: crossedNow ? nowIso : prev?.completedAt,
      };

      if (crossedNow) {
        newlyCompleted.push(entry);
        if (milestone.targetRouteHint) {
          autoAdvanceRoute = milestone.targetRouteHint;
        }
        this.agentState?.set('lastCompletedMilestoneId', milestone.id);
        this.agentState?.appendMemory({
          source: 'progress_tracker',
          milestoneId: milestone.id,
          score: sim,
          message: `Completed "${milestone.label}" (cosine ${sim.toFixed(2)} ≥ ${milestone.completionThreshold.toFixed(2)})${
            milestone.targetRouteHint ? ` · auto-advance → ${milestone.targetRouteHint}` : ''
          }`,
        });
        this.onMilestoneCrossed?.(milestone, entry);
      }

      return entry;
    });

    if (autoAdvanceRoute) {
      this.agentState?.set('routeOverride', autoAdvanceRoute);
    }

    // Active focus = highest-scoring incomplete milestone (or overall highest if all completed)
    const activeIncomplete = nextProgress
      .filter((p) => !p.completed)
      .sort((a, b) => b.score - a.score);
    const highestOverall = [...nextProgress].sort((a, b) => b.score - a.score);
    const currentFocusId =
      activeIncomplete[0]?.milestoneId ?? highestOverall[0]?.milestoneId ?? null;

    const overallProgress =
      nextProgress.length > 0
        ? round4(nextProgress.reduce((acc, p) => acc + p.score, 0) / nextProgress.length)
        : 0;

    this.state = {
      ...this.state,
      progress: nextProgress,
      overallProgress,
      currentFocusId,
      lastOutputPreview: trimmed.slice(0, 180),
      lastStateVecPreview: (outputVec ?? []).slice(0, 24).map((v) => round4(v)),
      lastUpdatedAt: nowIso,
    };

    this.agentState?.set('currentFocusId', currentFocusId);

    return {
      state: this.getState(),
      newlyCompleted,
      autoAdvanceRoute,
    };
  }
}
