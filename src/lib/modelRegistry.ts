import fs from 'node:fs';
import path from 'node:path';
import type { EncoderModelId, LocalModelInventoryItem } from './types.ts';

export interface ModelSpec {
  id: EncoderModelId;
  hfRepo: string;
  dimensions: number;
  pooling: 'mean' | 'cls' | 'hybrid';
  maxTokens: number;
  supportsOnnx: boolean;
  queryPrefix: string;
  passagePrefix: string;
}

export const MODEL_SPECS: Record<EncoderModelId, ModelSpec> = {
  'e5-small-v2': {
    id: 'e5-small-v2',
    hfRepo: 'Xenova/e5-small-v2',
    dimensions: 384,
    pooling: 'mean',
    maxTokens: 512,
    supportsOnnx: true,
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
  },
  'e5-base-v2': {
    id: 'e5-base-v2',
    hfRepo: 'Xenova/e5-base-v2',
    dimensions: 768,
    pooling: 'mean',
    maxTokens: 512,
    supportsOnnx: true,
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
  },
  'e5-large-v2': {
    id: 'e5-large-v2',
    hfRepo: 'Xenova/e5-large-v2',
    dimensions: 1024,
    pooling: 'mean',
    maxTokens: 512,
    supportsOnnx: true,
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
  },
  'bge-m3': {
    id: 'bge-m3',
    hfRepo: 'Xenova/bge-m3',
    dimensions: 1024,
    pooling: 'cls',
    maxTokens: 8192,
    supportsOnnx: true,
    queryPrefix: '',
    passagePrefix: '',
  },
  'local-subword-bm25': {
    id: 'local-subword-bm25',
    hfRepo: 'local/subword-256d-bm25',
    dimensions: 256,
    pooling: 'hybrid',
    maxTokens: 4096,
    supportsOnnx: false,
    queryPrefix: '',
    passagePrefix: '',
  },
};

interface PersistedRegistryEntry {
  id?: string;
  hfRepo?: string;
  localPath?: string;
  quantization?: string;
  onnxFile?: string;
  dimensions?: number;
  pooling?: 'mean' | 'cls';
  maxTokens?: number;
  totalBytes?: number;
  clonedAt?: string;
}

function directoryByteSizeAndOnnx(dir: string): { totalBytes: number; onnxFile: string | null } {
  if (!fs.existsSync(dir)) return { totalBytes: 0, onnxFile: null };
  let totalBytes = 0;
  let onnxFile: string | null = null;
  const walk = (curr: string) => {
    for (const entry of fs.readdirSync(curr, { withFileTypes: true })) {
      const full = path.join(curr, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const stat = fs.statSync(full);
        // Ignore raw Git LFS ASCII pointer stubs (~130 bytes) when weights are not hydrated
        if (entry.name.endsWith('.onnx')) {
          if (stat.size > 1024) {
            onnxFile = path.relative(dir, full).replace(/\\/g, '/');
          }
        }
        totalBytes += stat.size;
      }
    }
  };
  walk(dir);
  return { totalBytes, onnxFile };
}

export function inspectLocalModelRegistry(rootDir: string): LocalModelInventoryItem[] {
  const modelsRoot = path.join(rootDir, 'models');
  const registryPath = path.join(modelsRoot, 'registry.json');
  const persistedByRepo = new Map<string, PersistedRegistryEntry>();

  if (fs.existsSync(registryPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as {
        models?: PersistedRegistryEntry[];
      };
      for (const m of parsed.models ?? []) {
        if (m.hfRepo) persistedByRepo.set(m.hfRepo, m);
      }
    } catch {
      // Ignore malformed registry.json
    }
  }

  const orderedIds: EncoderModelId[] = [
    'bge-m3',
    'e5-large-v2',
    'e5-base-v2',
    'e5-small-v2',
    'local-subword-bm25',
  ];

  return orderedIds.map((id) => {
    const spec = MODEL_SPECS[id];
    if (!spec.supportsOnnx) {
      return {
        id,
        hfRepo: spec.hfRepo,
        localPath: 'built-in',
        installedInLfs: true,
        onnxFile: null,
        quantization: 'native-ts',
        dimensions: spec.dimensions,
        pooling: spec.pooling,
        maxTokens: spec.maxTokens,
        totalBytes: 0,
        source: 'deterministic-local',
        clonedAt: null,
      };
    }

    const localDir = path.join(modelsRoot, spec.hfRepo);
    const hasConfig = fs.existsSync(path.join(localDir, 'config.json'));
    const disk = directoryByteSizeAndOnnx(localDir);
    const reg = persistedByRepo.get(spec.hfRepo);
    const installedInLfs = hasConfig && Boolean(disk.onnxFile);

    return {
      id,
      hfRepo: spec.hfRepo,
      localPath: path.posix.join('models', spec.hfRepo),
      installedInLfs,
      onnxFile: disk.onnxFile ?? reg?.onnxFile ?? null,
      quantization: reg?.quantization ?? (installedInLfs ? 'q8' : null),
      dimensions: reg?.dimensions ?? spec.dimensions,
      pooling: spec.pooling,
      maxTokens: reg?.maxTokens ?? spec.maxTokens,
      totalBytes: disk.totalBytes || reg?.totalBytes || 0,
      source: installedInLfs ? 'git-lfs-local' : 'huggingface-cache-or-remote',
      clonedAt: reg?.clonedAt ?? null,
    };
  });
}

export function resolveTransformersModelTarget(
  modelId: EncoderModelId,
  rootDir: string
): {
  spec: ModelSpec;
  modelsRoot: string;
  localFilesOnly: boolean;
  source: 'git-lfs-local' | 'huggingface-remote';
  dtype: 'q8' | 'fp16' | 'fp32';
} {
  const spec = MODEL_SPECS[modelId] ?? MODEL_SPECS['e5-small-v2'];
  const modelsRoot = path.join(rootDir, 'models');
  const localDir = path.join(modelsRoot, spec.hfRepo);
  const disk = directoryByteSizeAndOnnx(localDir);
  const hasConfig = fs.existsSync(path.join(localDir, 'config.json'));
  const installedInLfs = hasConfig && Boolean(disk.onnxFile);

  let dtype: 'q8' | 'fp16' | 'fp32' = 'q8';
  if (disk.onnxFile?.includes('fp16')) dtype = 'fp16';
  else if (disk.onnxFile === 'onnx/model.onnx') dtype = 'fp32';

  return {
    spec,
    modelsRoot,
    localFilesOnly: installedInLfs,
    source: installedInLfs ? 'git-lfs-local' : 'huggingface-remote',
    dtype,
  };
}
