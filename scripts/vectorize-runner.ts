#!/usr/bin/env tsx
/**
 * External Chunking & Vectorizing Runner
 * Used locally via `npm run vectorize -- ...` or on GitHub Actions (`vectorize-sources.yml`).
 * Prefers local Git LFS ONNX models under `models/` and persists Float32 vectors + manifests
 * to `data/packages/` and `data/router-state.json`.
 */
import path from 'node:path';
import { ChatGptAuthManager } from '../src/lib/chatgptAuth.ts';
import { UnifiedRouterService } from '../src/lib/routerService.ts';
import { TelemetryCollector } from '../src/lib/telemetry.ts';
import type { ArchiveFilterProfile, EncoderModelId } from '../src/lib/types.ts';

interface RunnerArgs {
  source: string;
  model: EncoderModelId;
  profile: ArchiveFilterProfile;
  chunkSize: number;
  chunkOverlap: number;
  batchSize: number;
  maxChars?: number;
  smokeQuery?: string;
  allowRemote: boolean;
  rootDir: string;
}

function parseArgs(argv: string[]): RunnerArgs {
  const args: RunnerArgs = {
    source: 'public/assets/aistudio/rea-rea-agents-6.8.0_a6250980.zip',
    model: 'e5-small-v2',
    profile: 'full-scripts',
    chunkSize: 1800,
    chunkOverlap: 120,
    batchSize: 4,
    allowRemote: true,
    rootDir: process.cwd(),
  };

  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--source' && next) {
      args.source = next.trim();
      i++;
    } else if (flag === '--model' && next) {
      args.model = next.trim() as EncoderModelId;
      i++;
    } else if (flag === '--profile' && next) {
      args.profile = next.trim() === 'core-docs' ? 'core-docs' : 'full-scripts';
      i++;
    } else if (flag === '--chunk-size' && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n >= 200) args.chunkSize = n;
      i++;
    } else if (flag === '--chunk-overlap' && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n >= 0) args.chunkOverlap = n;
      i++;
    } else if (flag === '--batch-size' && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n >= 1) args.batchSize = n;
      i++;
    } else if (flag === '--max-chars' && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n >= 128) args.maxChars = n;
      i++;
    } else if (flag === '--smoke-query' && next) {
      args.smokeQuery = next.trim();
      i++;
    } else if (flag === '--offline-only') {
      args.allowRemote = false;
    } else if (flag === '--root' && next) {
      args.rootDir = path.resolve(next);
      i++;
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const telemetry = new TelemetryCollector();
  const auth = new ChatGptAuthManager(args.rootDir);
  const service = new UnifiedRouterService(args.rootDir, auth, telemetry);

  const lfsAvailable = service.hasLocalLfsModel(args.model);
  console.log(
    `[vectorize-runner] Starting ingestion: source="${args.source}" model=${args.model} (lfs=${lfsAvailable}) profile=${args.profile} chunk=${args.chunkSize}/${args.chunkOverlap} bs=${args.batchSize}${args.maxChars ? ` maxChars=${args.maxChars}` : ''}`
  );

  let lastLogged = 0;
  const startedAt = Date.now();
  const { manifest, connector } = await service.ingestPackageArchive({
    archivePath: args.source,
    encoderModel: args.model,
    filterProfile: args.profile,
    chunkSize: args.chunkSize,
    chunkOverlap: args.chunkOverlap,
    batchSize: args.batchSize,
    maxChars: args.maxChars,
    allowRemoteModelDownload: args.allowRemote,
    onProgress: (processed, total) => {
      if (processed === total || processed - lastLogged >= 200) {
        lastLogged = processed;
        const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`[vectorize-runner] Embedded ${processed}/${total} chunks (${elapsedSec}s)`);
      }
    },
  });

  console.log(
    `[vectorize-runner] Saved ${manifest.id} (${manifest.packageName}@${manifest.version}): ${manifest.fileCount} files -> ${manifest.chunkCount} chunks (${manifest.dimensions}d, ${manifest.encoderModel}) in ${manifest.latencyMs.toFixed(0)}ms`
  );
  console.log(`[vectorize-runner] Categories: ${JSON.stringify(manifest.categories)}`);
  console.log(
    `[vectorize-runner] Registered connector: ${connector.id} (${connector.url}) · vectors: ${manifest.storageFiles.vectors}`
  );

  if (args.smokeQuery) {
    console.log(`[vectorize-runner] Running smoke check: "${args.smokeQuery}"`);
    const ragRes = await service.queryRag({
      query: args.smokeQuery,
      connectorIds: [manifest.connectorId],
      topK: 3,
    });
    const routeRes = await service.routePrompt({
      query: args.smokeQuery,
      useRag: true,
      executeProvider: false,
      transport: 'http',
    });

    console.log(
      `[vectorize-runner] RAG top hit: ${ragRes.matches[0]?.filePath ?? 'none'} (score=${ragRes.matches[0]?.score.toFixed(4) ?? '0'})`
    );
    console.log(
      `[vectorize-runner] Route decision: matchedRoute=${routeRes.matchedRoute ?? 'null'} -> targetModel=${routeRes.targetModel ?? 'null'} (topScore=${routeRes.topScore.toFixed(4)}, threshold=${routeRes.thresholdUsed?.toFixed(2) ?? 'n/a'})`
    );
  }
}

main().catch((err) => {
  console.error('[vectorize-runner] Fatal error:', err);
  process.exit(1);
});
