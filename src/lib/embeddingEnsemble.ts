import {
  createLocalVectorLookup,
  fuseEnsembleScores,
  runParallelEmbeddings,
  scoreRoutesEnsemble,
  type EnsembleSlotLookup,
  type EnsembleVectorLookup,
  type VectorLookup,
} from './routerEngine.ts';
import type {
  EmbeddingSlotRole,
  EncoderModelId,
  EnsembleConfig,
  EnsembleFusionMode,
  RouteDefinition,
  RouterConfig,
} from './types.ts';

export interface EnsembleRunnerSlot extends EnsembleSlotLookup {
  modelId: EncoderModelId;
}

/**
 * Coordinates 3 specialized embedding lookups (intent, domain, state)
 * so query & passage encoding executes in parallel across heterogeneous vector spaces
 * and fuses per-slot similarities into a single routing decision.
 */
export class EmbeddingEnsembleRunner {
  private readonly slots: EnsembleRunnerSlot[];
  private readonly fusionMode: EnsembleFusionMode;

  constructor(opts: {
    slots: EnsembleRunnerSlot[];
    fusionMode: EnsembleFusionMode;
  }) {
    this.slots = opts.slots;
    this.fusionMode = opts.fusionMode;
  }

  getActiveSlots(): EnsembleRunnerSlot[] {
    return this.slots.filter((s) => s.enabled !== false);
  }

  getSlot(role: EmbeddingSlotRole): EnsembleRunnerSlot | undefined {
    return this.slots.find((s) => s.role === role);
  }

  toVectorLookup(): EnsembleVectorLookup {
    return {
      slots: this.getActiveSlots().map((s) => ({
        role: s.role,
        lookup: s.lookup,
        weight: s.weight,
        enabled: s.enabled,
      })),
      fusionMode: this.fusionMode,
    };
  }

  async embedParallel(texts: string[]): Promise<Record<EmbeddingSlotRole, number[][]>> {
    const active = this.getActiveSlots();
    return runParallelEmbeddings(
      texts,
      active.map((s) => ({ role: s.role, lookup: s.lookup }))
    );
  }

  fuse(perSlotScores: Array<{ role: EmbeddingSlotRole; score: number; weight: number }>): number {
    return fuseEnsembleScores(perSlotScores, this.fusionMode);
  }

  score(query: string, routes: RouteDefinition[], config: RouterConfig) {
    return scoreRoutesEnsemble(query, routes, config, this.toVectorLookup());
  }
}

export function createDefaultLocalEnsembleRunner(
  ensembleConfig?: EnsembleConfig
): EmbeddingEnsembleRunner {
  const defaultDims: Record<EncoderModelId, number> = {
    'e5-small-v2': 384,
    'e5-base-v2': 768,
    'e5-large-v2': 1024,
    'local-subword-bm25': 256,
    'bge-m3': 1024,
  };

  const slotConfigs = ensembleConfig?.slots ?? [
    { role: 'intent' as const, modelId: 'e5-small-v2' as const, weight: 0.4, enabled: true },
    { role: 'domain' as const, modelId: 'local-subword-bm25' as const, weight: 0.4, enabled: true },
    { role: 'state' as const, modelId: 'bge-m3' as const, weight: 0.2, enabled: true },
  ];

  const slots: EnsembleRunnerSlot[] = slotConfigs.map((cfg) => ({
    role: cfg.role,
    modelId: cfg.modelId,
    weight: cfg.weight,
    enabled: cfg.enabled,
    lookup: createLocalVectorLookup(defaultDims[cfg.modelId] ?? 256),
  }));

  return new EmbeddingEnsembleRunner({
    slots,
    fusionMode: ensembleConfig?.fusionMode ?? 'weighted_sum',
  });
}

export type { VectorLookup };
