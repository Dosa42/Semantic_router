#!/usr/bin/env node
/**
 * One-time model fetcher for Git LFS (`models/`).
 * Clones ONNX weights + tokenizers for selected Hugging Face embedding candidates
 * (`Xenova/bge-m3`, `Xenova/e5-base-v2`, `Xenova/e5-large-v2`, `Xenova/e5-small-v2`),
 * runs a local @huggingface/transformers smoke check, and writes `models/registry.json`.
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CANDIDATES = {
  'Xenova/bge-m3': {
    id: 'bge-m3',
    dimensions: 1024,
    pooling: 'cls',
    maxTokens: 8192,
  },
  'Xenova/e5-large-v2': {
    id: 'e5-large-v2',
    dimensions: 1024,
    pooling: 'mean',
    maxTokens: 512,
  },
  'Xenova/e5-base-v2': {
    id: 'e5-base-v2',
    dimensions: 768,
    pooling: 'mean',
    maxTokens: 512,
  },
  'Xenova/e5-small-v2': {
    id: 'e5-small-v2',
    dimensions: 384,
    pooling: 'mean',
    maxTokens: 512,
  },
};

function parseArgs(argv) {
  const args = {
    models: ['Xenova/bge-m3', 'Xenova/e5-base-v2', 'Xenova/e5-large-v2'],
    dtype: 'q8',
    smokeTest: true,
    rootDir: process.cwd(),
  };

  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--models' && next) {
      args.models = next
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      i++;
    } else if (flag === '--dtype' && next) {
      args.dtype = next.trim();
      i++;
    } else if (flag === '--no-smoke') {
      args.smokeTest = false;
    } else if (flag === '--root' && next) {
      args.rootDir = path.resolve(next);
      i++;
    }
  }
  return args;
}

function selectRepoFiles(treeEntries, dtype) {
  const essentialRoot = new Set([
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'vocab.txt',
    'sentencepiece.bpe.model',
    'tokenizer.model',
  ]);

  const onnxPreference =
    dtype === 'fp32'
      ? ['onnx/model.onnx', 'onnx/model_fp16.onnx', 'onnx/model_quantized.onnx']
      : dtype === 'fp16'
        ? ['onnx/model_fp16.onnx', 'onnx/model.onnx', 'onnx/model_quantized.onnx']
        : ['onnx/model_quantized.onnx', 'onnx/model_int8.onnx', 'onnx/model.onnx'];

  const allPaths = new Set(treeEntries.filter((e) => e.type === 'file').map((e) => e.path));
  const selected = [];

  for (const f of essentialRoot) {
    if (allPaths.has(f)) selected.push(f);
  }

  let chosenOnnx = null;
  for (const cand of onnxPreference) {
    if (allPaths.has(cand)) {
      chosenOnnx = cand;
      break;
    }
  }
  if (!chosenOnnx) {
    chosenOnnx = [...allPaths].find((p) => p.startsWith('onnx/') && p.endsWith('.onnx')) || null;
  }
  if (!chosenOnnx) {
    throw new Error(`No ONNX weight file found in repository tree.`);
  }
  selected.push(chosenOnnx);

  // Include matching external data weights if model splits >2GB shards (e.g. model_quantized.onnx_data)
  const dataCompanion = `${chosenOnnx}_data`;
  if (allPaths.has(dataCompanion)) {
    selected.push(dataCompanion);
  }
  const baseData = 'onnx/model.onnx_data';
  if (chosenOnnx === 'onnx/model.onnx' && allPaths.has(baseData)) {
    selected.push(baseData);
  }

  return { selected, chosenOnnx };
}

async function fetchRepoTree(repoId) {
  const treeUrl = `https://huggingface.co/api/models/${repoId}/tree/main?recursive=true`;
  const res = await fetch(treeUrl, {
    headers: process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : undefined,
  });
  if (!res.ok) {
    throw new Error(`HF tree API failed for ${repoId}: HTTP ${res.status}`);
  }
  return await res.json();
}

async function downloadFile(repoId, repoFilePath, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const url = `https://huggingface.co/${repoId}/resolve/main/${repoFilePath}`;
  const res = await fetch(url, {
    redirect: 'follow',
    headers: process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : undefined,
  });
  if (!res.ok) {
    throw new Error(`Failed downloading ${url}: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

async function main() {
  const args = parseArgs(process.argv);
  const modelsRoot = path.join(args.rootDir, 'models');
  fs.mkdirSync(modelsRoot, { recursive: true });

  const registryPath = path.join(modelsRoot, 'registry.json');
  let existingEntries = [];
  if (fs.existsSync(registryPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      if (Array.isArray(prev.models)) existingEntries = prev.models;
    } catch {
      existingEntries = [];
    }
  }

  const byRepo = new Map(existingEntries.map((m) => [m.hfRepo, m]));

  for (const repoId of args.models) {
    console.log(`[fetch-models-lfs] Fetching file tree for ${repoId}...`);
    const tree = await fetchRepoTree(repoId);
    const { selected, chosenOnnx } = selectRepoFiles(tree, args.dtype);

    const localDir = path.join(modelsRoot, repoId);
    let totalBytes = 0;
    for (const relFile of selected) {
      const dest = path.join(localDir, relFile);
      console.log(`  -> downloading ${repoId}/${relFile}`);
      const bytes = await downloadFile(repoId, relFile, dest);
      totalBytes += bytes;
      console.log(`     saved ${(bytes / (1024 * 1024)).toFixed(2)} MB`);
    }

    const meta = DEFAULT_CANDIDATES[repoId] ?? {
      id: repoId.split('/').pop()?.toLowerCase() || repoId,
      dimensions: 768,
      pooling: repoId.includes('bge') ? 'cls' : 'mean',
      maxTokens: 512,
    };

    if (args.smokeTest) {
      console.log(`[fetch-models-lfs] Running local offline ONNX smoke test for ${repoId}...`);
      const { env, pipeline } = await import('@huggingface/transformers');
      env.localModelPath = modelsRoot;
      env.allowRemoteModels = false;
      const ext = await pipeline('feature-extraction', repoId, {
        dtype: args.dtype === 'fp32' ? 'fp32' : args.dtype === 'fp16' ? 'fp16' : 'q8',
        local_files_only: true,
      });
      const out = await ext(['REA Agents Frida MCP contract smoke verification'], {
        pooling: meta.pooling,
        normalize: true,
      });
      const vec = out.tolist()[0];
      console.log(`  -> verified offline inference: dims=${vec.length}`);
      meta.dimensions = vec.length;
    }

    byRepo.set(repoId, {
      id: meta.id,
      hfRepo: repoId,
      localPath: path.posix.join('models', repoId),
      quantization: args.dtype,
      onnxFile: chosenOnnx,
      dimensions: meta.dimensions,
      pooling: meta.pooling,
      maxTokens: meta.maxTokens,
      totalBytes,
      clonedAt: new Date().toISOString(),
    });
  }

  const registry = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    lfsTrackedDirectory: 'models',
    models: Array.from(byRepo.values()),
  };
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');
  console.log(`[fetch-models-lfs] Updated ${registryPath} with ${registry.models.length} models.`);
}

main().catch((err) => {
  console.error('[fetch-models-lfs] Error:', err);
  process.exit(1);
});
