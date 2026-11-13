import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ChatGptAuthManager } from './chatgptAuth.ts';
import { invokeSingleMcpJsonRpc } from './mcpServer.ts';
import {
  inspectLocalModelRegistry,
  resolveTransformersModelTarget,
} from './modelRegistry.ts';
import {
  classifyArchiveEntry,
  deletePackageVectorStoreByConnector,
  extractAndChunkZipArchive,
  loadAllPackageVectorStores,
  normalizeVectorInPlace,
  readDirectoryEntries,
  readZipEntries,
  savePackageVectorStore,
  scorePackageVectorStore,
} from './packageIngestor.ts';
import { createLocalVectorLookup } from './routerEngine.ts';
import { UnifiedRouterService } from './routerService.ts';
import { TelemetryCollector } from './telemetry.ts';

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Minimal standard ZIP builder supporting Store (0) and Deflate (8) for hermetic unit tests.
 */
function buildTestZip(
  files: Array<{ name: string; content: string; deflate?: boolean }>
): Buffer {
  const localParts: Buffer[] = [];
  const cdParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const rawBuf = Buffer.from(file.content, 'utf8');
    const useDeflate = Boolean(file.deflate);
    const dataBuf = useDeflate ? zlib.deflateRawSync(rawBuf) : rawBuf;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(rawBuf);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(dataBuf.length, 18);
    lfh.writeUInt32LE(rawBuf.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(dataBuf.length, 20);
    cd.writeUInt32LE(rawBuf.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);

    localParts.push(lfh, nameBuf, dataBuf);
    cdParts.push(cd, nameBuf);
    offset += lfh.length + nameBuf.length + dataBuf.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

test('readZipEntries parses Store and Deflate entries and strips common root folder', () => {
  const zip = buildTestZip([
    { name: 'rea-demo-1.0.0/README.md', content: '# REA Demo\nFrida bridge.', deflate: true },
    { name: 'rea-demo-1.0.0/package.json', content: '{"name":"rea-agents","version":"6.8.0"}', deflate: false },
  ]);

  const entries = readZipEntries(zip);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].relativePath, 'README.md');
  assert.equal(entries[0].contentBuffer.toString('utf8'), '# REA Demo\nFrida bridge.');
  assert.equal(entries[1].relativePath, 'package.json');
});

test('classifyArchiveEntry keeps high-signal REA paths and filters out noise/translations/tests', () => {
  assert.equal(classifyArchiveEntry('README.md', 1024), 'root');
  assert.equal(classifyArchiveEntry('AGENTS.md', 2048), 'root');
  assert.equal(classifyArchiveEntry('.agents/skills/mcp/SKILL.md', 1500), 'agents');
  assert.equal(classifyArchiveEntry('docs/specs/frida.md', 4000), 'specs');
  assert.equal(classifyArchiveEntry('docs/mcp-contracts.md', 8000), 'docs');
  assert.equal(classifyArchiveEntry('bridge/ghidra_bridge.py', 12000), 'bridge');
  assert.equal(classifyArchiveEntry('scripts/rea.mjs', 4500), 'scripts');
  assert.equal(classifyArchiveEntry('scripts/rea.mjs', 4500, 'full-scripts'), 'scripts');
  assert.equal(classifyArchiveEntry('scripts/rea.mjs', 4500, 'core-docs'), null);
  assert.equal(classifyArchiveEntry('src/contracts/evidence.ts', 5000), 'contracts');
  assert.equal(classifyArchiveEntry('src/server/McpServer.ts', 6000), 'core-src');

  assert.equal(classifyArchiveEntry('docs/readme/README.zh-CN.md', 5000), null);
  assert.equal(classifyArchiveEntry('docs/releases/6.8.0.contributions.json', 100000), null);
  assert.equal(classifyArchiveEntry('docs/verification/routes.json', 50000), null);
  assert.equal(classifyArchiveEntry('website/index.html', 2000), null);
  assert.equal(classifyArchiveEntry('tests/server.test.ts', 2000), null);
  assert.equal(classifyArchiveEntry('src/server/McpServer.test.ts', 2000), null);
  assert.equal(classifyArchiveEntry('package-lock.json', 200000), null);
});

test('savePackageVectorStore persists Float32 vectors and scorePackageVectorStore ranks matches', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-pkg-store-'));
  try {
    const zipPath = path.join(tmpDir, 'sample-rea.zip');
    const zipBuf = buildTestZip([
      {
        name: 'rea-rea-agents-6.8.0/package.json',
        content: JSON.stringify({ name: 'rea-agents', version: '6.8.0' }),
        deflate: true,
      },
      {
        name: 'rea-rea-agents-6.8.0/docs/frida-mcp.md',
        content:
          'Frida dynamic instrumentation hooks native functions and sends structured telemetry over MCP stdio.',
        deflate: true,
      },
      {
        name: 'rea-rea-agents-6.8.0/bridge/ghidra_bridge.py',
        content:
          'Ghidra bridge exposes headless decompilation and symbol cross-references to REA agents.',
        deflate: true,
      },
    ]);
    fs.writeFileSync(zipPath, zipBuf);

    const extracted = extractAndChunkZipArchive({ archivePath: zipPath, rootDir: tmpDir });
    assert.equal(extracted.packageName, 'rea-agents');
    assert.equal(extracted.version, '6.8.0');
    assert.ok(extracted.chunks.length >= 3);

    const dims = 256;
    const lookup = createLocalVectorLookup(dims);
    const vectors = new Float32Array(extracted.chunks.length * dims);
    for (let i = 0; i < extracted.chunks.length; i++) {
      const v = lookup.getVector(extracted.chunks[i].text);
      for (let d = 0; d < dims; d++) vectors[i * dims + d] = v[d] ?? 0;
      normalizeVectorInPlace(vectors, i * dims, dims);
    }

    const packagesDir = path.join(tmpDir, 'data', 'packages');
    const manifest = savePackageVectorStore({
      packagesDir,
      manifest: {
        id: extracted.packageId,
        packageName: extracted.packageName,
        version: extracted.version,
        sourceArchive: extracted.sourceArchive,
        connectorId: extracted.connectorId,
        connectorName: extracted.connectorName,
        encoderModel: 'local-subword-bm25',
        dimensions: dims,
        chunkCount: extracted.chunks.length,
        fileCount: extracted.fileCount,
        totalChars: extracted.totalChars,
        categories: extracted.categories,
        ingestedAt: new Date().toISOString(),
        latencyMs: 5,
      },
      chunks: extracted.chunks,
      vectors,
    });

    assert.equal(manifest.chunkCount, extracted.chunks.length);
    const loaded = loadAllPackageVectorStores(packagesDir);
    assert.equal(loaded.length, 1);

    const qVec = lookup.getVector('Frida dynamic instrumentation MCP');
    const hits = scorePackageVectorStore(
      'Frida dynamic instrumentation MCP',
      loaded[0],
      {
        mode: 'hybrid',
        alpha: 0.7,
        aggregation: 'max',
        defaultThreshold: 0.3,
        encoderModel: 'local-subword-bm25',
        mcpEnabled: true,
        ragEnabledByDefault: true,
      },
      qVec,
      { topK: 2 }
    );
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].filePath, 'docs/frida-mcp.md');

    assert.equal(deletePackageVectorStoreByConnector(packagesDir, extracted.connectorId), true);
    assert.equal(loadAllPackageVectorStores(packagesDir).length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('UnifiedRouterService ingests ZIP package, persists across reload, routes rea_agents, and serves MCP stdio tools', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-pkg-service-'));
  try {
    const assetsDir = path.join(tmpDir, 'public', 'assets', 'aistudio');
    fs.mkdirSync(assetsDir, { recursive: true });
    const zipPath = path.join(assetsDir, 'rea-rea-agents-6.8.0_test.zip');
    fs.writeFileSync(
      zipPath,
      buildTestZip([
        {
          name: 'rea-rea-agents-6.8.0/package.json',
          content: JSON.stringify({ name: 'rea-agents', version: '6.8.0' }),
          deflate: true,
        },
        {
          name: 'rea-rea-agents-6.8.0/docs/specs/frida-instrumentation.md',
          content:
            'REA Agents exposes Frida instrumentation scripts, Interceptor.attach hooks, and session telemetry over MCP tools.',
          deflate: true,
        },
        {
          name: 'rea-rea-agents-6.8.0/bridge/ghidra_mcp_bridge.py',
          content:
            'Ghidra bridge connects headless decompilation and function cross-references to REA MCP server contracts.',
          deflate: true,
        },
      ])
    );

    const telemetry = new TelemetryCollector();
    const auth = new ChatGptAuthManager(tmpDir);
    const service = new UnifiedRouterService(tmpDir, auth, telemetry);
    service.updateConfig({
      encoderModel: 'local-subword-bm25',
      encoderEnsemble: {
        slots: [
          { role: 'intent', modelId: 'local-subword-bm25', weight: 0.4, enabled: true },
          { role: 'domain', modelId: 'local-subword-bm25', weight: 0.4, enabled: true },
          { role: 'state', modelId: 'bge-m3', weight: 0.2, enabled: true },
        ],
        fusionMode: 'weighted_sum',
        parallelLoad: true,
      },
    });
    for (const r of service.getRoutes()) {
      service.updateRoute(r.id, { scoreThreshold: 0.24 });
    }

    const ingestRes = await service.ingestPackageArchive({
      archivePath: 'public/assets/aistudio/rea-rea-agents-6.8.0_test.zip',
      encoderModel: 'local-subword-bm25',
    });
    assert.equal(ingestRes.manifest.id, 'rea-agents-6.8.0');
    assert.equal(ingestRes.connector.id, 'rag-conn-rea-agents-6.8.0');
    assert.equal(ingestRes.connector.lastStatus, 'ok');

    // Reload fresh UnifiedRouterService from disk to verify persisted Float32 store reloads
    const reloaded = new UnifiedRouterService(tmpDir, auth, telemetry);
    assert.equal(reloaded.getIngestedPackages().length, 1);
    assert.ok(reloaded.getTotalRagChunksCount() >= 3);

    // Query via RAG directly
    const ragRes = await reloaded.queryRag({
      query: 'Frida instrumentation Interceptor.attach MCP',
      topK: 2,
    });
    assert.ok(ragRes.matches.length >= 1);
    assert.equal(ragRes.matches[0].filePath, 'docs/specs/frida-instrumentation.md');

    // Route prompt through HTTP/Router path + execute tool:rea_agents_rag
    const routed = await reloaded.routePrompt({
      query: 'How does REA Agents expose Frida instrumentation and Ghidra bridges over MCP?',
      useRag: true,
      executeProvider: true,
    });
    assert.equal(routed.matchedRoute, 'rea_agents');
    assert.equal(routed.targetModel, 'tool:rea_agents_rag');
    assert.ok((routed.ragMatches?.length ?? 0) >= 1);
    assert.equal(routed.providerExecution?.status, 'ok');

    // Verify MCP stdio tools: list_ingested_packages, rag_retrieve, and rag://packages
    const listRes = await invokeSingleMcpJsonRpc(reloaded, telemetry, {
      jsonrpc: '2.0',
      id: 201,
      method: 'tools/call',
      params: { name: 'list_ingested_packages', arguments: {} },
    });
    const listData = (
      listRes.response.result as { structuredContent: { packages: Array<{ id: string }> } }
    ).structuredContent;
    assert.equal(listData.packages[0].id, 'rea-agents-6.8.0');

    const mcpRag = await invokeSingleMcpJsonRpc(reloaded, telemetry, {
      jsonrpc: '2.0',
      id: 202,
      method: 'tools/call',
      params: {
        name: 'rag_retrieve',
        arguments: { query: 'Ghidra bridge decompilation', topK: 2 },
      },
    });
    const mcpRagData = (
      mcpRag.response.result as { structuredContent: { matches: Array<{ filePath?: string }> } }
    ).structuredContent;
    assert.equal(mcpRagData.matches[0].filePath, 'bridge/ghidra_mcp_bridge.py');

    const pkgResource = await invokeSingleMcpJsonRpc(reloaded, telemetry, {
      jsonrpc: '2.0',
      id: 203,
      method: 'resources/read',
      params: { uri: 'rag://packages' },
    });
    const resText = (
      pkgResource.response.result as { contents: Array<{ text: string }> }
    ).contents[0].text;
    assert.ok(resText.includes('rea-agents-6.8.0'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('directory source extraction honors full-scripts vs core-docs filter profiles', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-dir-source-'));
  try {
    const pkgRoot = path.join(tmpDir, 'external-source');
    fs.mkdirSync(path.join(pkgRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(pkgRoot, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({ name: 'rea-agents', version: '6.8.1' })
    );
    fs.writeFileSync(
      path.join(pkgRoot, 'scripts', 'rea.mjs'),
      'export function runHook() { return "frida-hook"; }'
    );
    fs.writeFileSync(
      path.join(pkgRoot, 'docs', 'overview.md'),
      '# Overview\nREA Agents architecture.'
    );

    const directFiles = readDirectoryEntries(pkgRoot);
    assert.equal(directFiles.length, 3);

    const fullRes = extractAndChunkZipArchive({
      archivePath: 'external-source',
      rootDir: tmpDir,
      filterProfile: 'full-scripts',
    });
    assert.equal(fullRes.categories.scripts, 1);
    assert.ok(fullRes.chunks.some((c) => c.filePath === 'scripts/rea.mjs'));

    const coreRes = extractAndChunkZipArchive({
      archivePath: 'external-source',
      rootDir: tmpDir,
      filterProfile: 'core-docs',
    });
    assert.equal(coreRes.categories.scripts ?? 0, 0);
    assert.equal(
      coreRes.chunks.some((c) => c.filePath === 'scripts/rea.mjs'),
      false
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('inspectLocalModelRegistry ignores raw Git LFS pointers and activates hydrated ONNX models', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-lfs-models-'));
  try {
    const bgeDir = path.join(tmpDir, 'models', 'Xenova', 'bge-m3', 'onnx');
    fs.mkdirSync(bgeDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'models', 'Xenova', 'bge-m3', 'config.json'), '{}');
    // Write small Git LFS pointer stub (< 1024 bytes) -> must NOT count as hydrated
    fs.writeFileSync(
      path.join(bgeDir, 'model_quantized.onnx'),
      'version https://git-lfs.github.com/spec/v1\noid sha256:0000\nsize 542000000\n'
    );

    let inv = inspectLocalModelRegistry(tmpDir);
    let bgeItem = inv.find((m) => m.id === 'bge-m3');
    assert.equal(bgeItem?.installedInLfs, false);
    let target = resolveTransformersModelTarget('bge-m3', tmpDir);
    assert.equal(target.localFilesOnly, false);

    // Replace stub with > 1KB binary weight payload -> must activate local Git LFS target
    fs.writeFileSync(path.join(bgeDir, 'model_quantized.onnx'), Buffer.alloc(4096, 7));
    inv = inspectLocalModelRegistry(tmpDir);
    bgeItem = inv.find((m) => m.id === 'bge-m3');
    assert.equal(bgeItem?.installedInLfs, true);
    assert.equal(bgeItem?.source, 'git-lfs-local');
    assert.equal(bgeItem?.onnxFile, 'onnx/model_quantized.onnx');

    target = resolveTransformersModelTarget('bge-m3', tmpDir);
    assert.equal(target.localFilesOnly, true);
    assert.equal(target.source, 'git-lfs-local');
    assert.equal(target.dtype, 'q8');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

