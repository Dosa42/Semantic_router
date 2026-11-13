import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { chunkText } from './ragEngine.ts';
import {
  blendScore,
  computeLocalDenseVector,
  computeSparseSimilarity,
  cosineSimilarity,
} from './routerEngine.ts';
import type {
  ArchiveFilterProfile,
  DiscoveredZipArchive,
  IngestedPackageChunk,
  IngestedPackageManifest,
  RagRetrievalMatch,
  RouterConfig,
} from './types.ts';

export interface ZipEntryData {
  rawName: string;
  relativePath: string;
  compressionMethod: number;
  uncompressedSize: number;
  contentBuffer: Buffer;
}

export interface LoadedPackageStore {
  manifest: IngestedPackageManifest;
  chunks: IngestedPackageChunk[];
  vectors: Float32Array;
}

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.txt',
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.py',
  '.java',
  '.swift',
  '.json',
  '.mermaid',
  '.toml',
  '.yaml',
  '.yml',
  '.sh',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
]);

const SKIP_FILENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.ds_store',
  'thumbs.db',
]);

/**
 * Pure Node.js ZIP reader supporting Method 0 (Store) and Method 8 (Deflate).
 * Reads the Central Directory for exact compressed sizes and file offsets.
 */
export function readZipEntries(
  zipBuffer: Buffer,
  shouldRead?: (relativePath: string, uncompressedSize: number) => boolean
): ZipEntryData[] {
  let eocdOffset = -1;
  const minSearch = Math.max(0, zipBuffer.length - 65557);
  for (let i = zipBuffer.length - 22; i >= minSearch; i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Invalid ZIP archive: End of Central Directory (EOCD) signature not found.');
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  const rawEntries: Array<{
    rawName: string;
    compressionMethod: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
  }> = [];

  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > zipBuffer.length || zipBuffer.readUInt32LE(pos) !== 0x02014b50) {
      break;
    }
    const compressionMethod = zipBuffer.readUInt16LE(pos + 10);
    const compressedSize = zipBuffer.readUInt32LE(pos + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(pos + 24);
    const nameLen = zipBuffer.readUInt16LE(pos + 28);
    const extraLen = zipBuffer.readUInt16LE(pos + 30);
    const commentLen = zipBuffer.readUInt16LE(pos + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(pos + 42);
    const rawName = zipBuffer.toString('utf8', pos + 46, pos + 46 + nameLen);

    pos += 46 + nameLen + extraLen + commentLen;
    if (rawName.endsWith('/')) continue;

    rawEntries.push({
      rawName,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
  }

  // Detect common top-level directory prefix (e.g. "rea-rea-agents-6.8.0/")
  let commonPrefix = '';
  if (rawEntries.length > 0) {
    const firstSlash = rawEntries[0].rawName.indexOf('/');
    if (firstSlash > 0) {
      const candidate = rawEntries[0].rawName.slice(0, firstSlash + 1);
      if (rawEntries.every((e) => e.rawName.startsWith(candidate))) {
        commonPrefix = candidate;
      }
    }
  }

  const decoded: ZipEntryData[] = [];
  for (const entry of rawEntries) {
    const relativePath = commonPrefix
      ? entry.rawName.slice(commonPrefix.length)
      : entry.rawName;

    if (shouldRead && !shouldRead(relativePath, entry.uncompressedSize)) {
      continue;
    }

    const lfh = entry.localHeaderOffset;
    if (lfh + 30 > zipBuffer.length || zipBuffer.readUInt32LE(lfh) !== 0x04034b50) {
      continue;
    }
    const localNameLen = zipBuffer.readUInt16LE(lfh + 26);
    const localExtraLen = zipBuffer.readUInt16LE(lfh + 28);
    const dataStart = lfh + 30 + localNameLen + localExtraLen;
    const dataEnd = Math.min(zipBuffer.length, dataStart + entry.compressedSize);
    const slice = zipBuffer.subarray(dataStart, dataEnd);

    let contentBuffer: Buffer;
    if (entry.compressionMethod === 0) {
      contentBuffer = Buffer.from(slice);
    } else if (entry.compressionMethod === 8) {
      contentBuffer = zlib.inflateRawSync(slice);
    } else {
      continue;
    }

    decoded.push({
      rawName: entry.rawName,
      relativePath,
      compressionMethod: entry.compressionMethod,
      uncompressedSize: entry.uncompressedSize,
      contentBuffer,
    });
  }

  return decoded;
}

export function readDirectoryEntries(
  dirPath: string,
  shouldRead?: (relativePath: string, sizeBytes: number) => boolean
): ZipEntryData[] {
  const results: ZipEntryData[] = [];
  const walk = (curr: string) => {
    for (const dirent of fs.readdirSync(curr, { withFileTypes: true })) {
      if (dirent.name === '.git' || dirent.name === 'node_modules') continue;
      const full = path.join(curr, dirent.name);
      if (dirent.isDirectory()) {
        walk(full);
      } else if (dirent.isFile()) {
        const stat = fs.statSync(full);
        const rel = path.relative(dirPath, full).replace(/\\/g, '/');
        if (shouldRead && !shouldRead(rel, stat.size)) continue;
        results.push({
          rawName: rel,
          relativePath: rel,
          compressionMethod: 0,
          uncompressedSize: stat.size,
          contentBuffer: fs.readFileSync(full),
        });
      }
    }
  };
  walk(dirPath);
  return results;
}

export function classifyArchiveEntry(
  relativePath: string,
  sizeBytes: number,
  profile: ArchiveFilterProfile = 'full-scripts'
): string | null {
  const rel = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel) return null;

  const baseName = path.posix.basename(rel).toLowerCase();
  if (SKIP_FILENAMES.has(baseName)) return null;

  // Exclude generated dumps, localized duplicates, build artifacts, CI metadata, and unit tests
  if (
    rel.startsWith('docs/readme/') ||
    rel.startsWith('docs/releases/') ||
    rel.startsWith('docs/verification/') ||
    rel.startsWith('docs/assets/') ||
    rel.startsWith('website/') ||
    rel.startsWith('tests/') ||
    rel.startsWith('experiments/') ||
    (profile === 'core-docs' && rel.startsWith('scripts/')) ||
    rel.startsWith('.github/') ||
    rel.startsWith('.husky/') ||
    rel.startsWith('licenses/') ||
    rel.startsWith('third_party/') ||
    rel.startsWith('node_modules/') ||
    rel.startsWith('dist/') ||
    rel.includes('.test.') ||
    rel.includes('.spec.')
  ) {
    return null;
  }

  const ext = path.posix.extname(rel).toLowerCase();
  const isRootNamedDoc =
    baseName === 'license' || baseName === 'agents.md' || baseName === 'readme.md';
  if (!TEXT_EXTENSIONS.has(ext) && !isRootNamedDoc) {
    return null;
  }

  // Skip unusually large generated data files
  if (sizeBytes > 250_000 && baseName !== 'changelog.md') {
    return null;
  }

  if (
    /^(README\.md|AGENTS\.md|CONTRIBUTING\.md|SECURITY\.md|DISCLAIMER\.md|server\.json|package\.json|turbo\.json|CHANGELOG\.md)$/i.test(
      rel
    )
  ) {
    return 'root';
  }
  if (rel.startsWith('.agents/')) return 'agents';
  if (rel.startsWith('docs/specs/')) return 'specs';
  if (rel.startsWith('docs/')) return 'docs';
  if (rel.startsWith('bridge/')) return 'bridge';
  if (rel.startsWith('src/contracts/')) return 'contracts';
  if (/^src\/(server|cli|main|composition)\//.test(rel)) return 'core-src';
  if (rel.startsWith('scripts/')) return 'scripts';
  if (rel.startsWith('native/') && sizeBytes <= 80_000) return 'source';

  // Generic archive fallback: keep concise markdown, text, or non-test root-adjacent source files
  if (ext === '.md' || ext === '.txt') return 'docs';
  if (!rel.startsWith('src/') && sizeBytes <= 80_000) return 'source';

  return null;
}

function sanitizePackageId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^@[^/]+\//, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function extractAndChunkZipArchive(opts: {
  archivePath: string;
  rootDir: string;
  chunkSize?: number;
  chunkOverlap?: number;
  filterProfile?: ArchiveFilterProfile;
}): {
  packageId: string;
  packageName: string;
  version: string;
  connectorId: string;
  connectorName: string;
  sourceArchive: string;
  filterProfile: ArchiveFilterProfile;
  fileCount: number;
  totalChars: number;
  categories: Record<string, number>;
  chunks: IngestedPackageChunk[];
} {
  const resolved = path.isAbsolute(opts.archivePath)
    ? opts.archivePath
    : path.resolve(opts.rootDir, opts.archivePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Package archive not found: ${opts.archivePath}`);
  }

  const filterProfile: ArchiveFilterProfile = opts.filterProfile ?? 'full-scripts';
  const stat = fs.statSync(resolved);
  const filterFn = (relativePath: string, uncompressedSize: number) =>
    classifyArchiveEntry(relativePath, uncompressedSize, filterProfile) !== null;

  const entries = stat.isDirectory()
    ? readDirectoryEntries(resolved, filterFn)
    : readZipEntries(fs.readFileSync(resolved), filterFn);

  // Detect package name & version from package.json / server.json / filename
  let packageName = path.basename(resolved, '.zip').replace(/_[a-f0-9]{6,}$/i, '');
  let version = '1.0.0';

  const pkgJsonEntry = entries.find((e) => e.relativePath === 'package.json');
  if (pkgJsonEntry) {
    try {
      const parsed = JSON.parse(pkgJsonEntry.contentBuffer.toString('utf8')) as {
        name?: string;
        version?: string;
      };
      if (parsed.name) packageName = parsed.name;
      if (parsed.version) version = parsed.version;
    } catch {
      // Ignore malformed package.json
    }
  } else {
    const serverJsonEntry = entries.find((e) => e.relativePath === 'server.json');
    if (serverJsonEntry) {
      try {
        const parsed = JSON.parse(serverJsonEntry.contentBuffer.toString('utf8')) as {
          name?: string;
          version?: string;
        };
        if (parsed.name) packageName = parsed.name;
        if (parsed.version) version = parsed.version;
      } catch {
        // Ignore
      }
    }
  }

  const cleanSlug = sanitizePackageId(packageName);
  const packageId = `${cleanSlug}-${sanitizePackageId(version)}`;
  const connectorId = `rag-conn-${packageId}`;
  const connectorName = `${packageName}@${version} Knowledge Base`;
  const sourceArchive = path.relative(opts.rootDir, resolved).replace(/\\/g, '/');

  const chunkSize = opts.chunkSize ?? 1200;
  const chunkOverlap = opts.chunkOverlap ?? 100;
  const fetchedAt = new Date().toISOString();

  const chunks: IngestedPackageChunk[] = [];
  const categories: Record<string, number> = {};
  let fileCount = 0;
  let totalChars = 0;

  for (const entry of entries) {
    const category = classifyArchiveEntry(
      entry.relativePath,
      entry.contentBuffer.length,
      filterProfile
    );
    if (!category) continue;

    // Guard against accidental binary data
    const sample = entry.contentBuffer.subarray(0, Math.min(512, entry.contentBuffer.length));
    if (sample.includes(0)) continue;

    let text = entry.contentBuffer.toString('utf8').replace(/\r\n/g, '\n').trim();
    if (!text) continue;

    // Cap changelog and unusually huge source files to preserve signal density
    const maxFileChars =
      entry.relativePath.toLowerCase() === 'changelog.md' ? 24_000 : 80_000;
    if (text.length > maxFileChars) {
      text = `${text.slice(0, maxFileChars)}\n\n[truncated at ${maxFileChars} chars]`;
    }

    const header = `[${packageName}@${version} | ${category} | ${entry.relativePath}]`;
    const bodyBudget = Math.max(200, chunkSize - header.length - 2);
    const slices = chunkText(text, bodyBudget, Math.min(chunkOverlap, Math.floor(bodyBudget / 3)));
    if (slices.length === 0) continue;

    fileCount += 1;
    categories[category] = (categories[category] ?? 0) + 1;

    for (let i = 0; i < slices.length; i++) {
      const fullChunkText = `${header}\n${slices[i]}`;
      totalChars += fullChunkText.length;
      chunks.push({
        id: `${connectorId}:chunk-${chunks.length}`,
        packageId,
        connectorId,
        connectorName,
        filePath: entry.relativePath,
        category,
        text: fullChunkText,
        chunkIndex: chunks.length,
        fetchedAt,
      });
    }
  }

  return {
    packageId,
    packageName,
    version,
    connectorId,
    connectorName,
    sourceArchive,
    filterProfile,
    fileCount,
    totalChars,
    categories,
    chunks,
  };
}

export function normalizeVectorInPlace(vec: Float32Array, offset: number, dims: number): void {
  let normSq = 0;
  for (let i = 0; i < dims; i++) {
    const v = vec[offset + i];
    normSq += v * v;
  }
  const norm = Math.sqrt(normSq);
  if (norm > 1e-12) {
    for (let i = 0; i < dims; i++) {
      vec[offset + i] = vec[offset + i] / norm;
    }
  }
}

export function savePackageVectorStore(opts: {
  packagesDir: string;
  manifest: Omit<IngestedPackageManifest, 'storageFiles'>;
  chunks: IngestedPackageChunk[];
  vectors: Float32Array;
}): IngestedPackageManifest {
  if (!fs.existsSync(opts.packagesDir)) {
    fs.mkdirSync(opts.packagesDir, { recursive: true });
  }

  const manifestFile = `${opts.manifest.id}.manifest.json`;
  const chunksFile = `${opts.manifest.id}.chunks.json`;
  const vectorsFile = `${opts.manifest.id}.vectors.f32`;

  const fullManifest: IngestedPackageManifest = {
    ...opts.manifest,
    storageFiles: {
      manifest: path.posix.join('data/packages', manifestFile),
      chunks: path.posix.join('data/packages', chunksFile),
      vectors: path.posix.join('data/packages', vectorsFile),
    },
  };

  fs.writeFileSync(
    path.join(opts.packagesDir, manifestFile),
    JSON.stringify(fullManifest, null, 2),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(opts.packagesDir, chunksFile),
    JSON.stringify(opts.chunks),
    'utf-8'
  );
  const rawBytes = Buffer.from(
    opts.vectors.buffer,
    opts.vectors.byteOffset,
    opts.vectors.byteLength
  );
  fs.writeFileSync(path.join(opts.packagesDir, vectorsFile), rawBytes);

  return fullManifest;
}

export function loadAllPackageVectorStores(packagesDir: string): LoadedPackageStore[] {
  if (!fs.existsSync(packagesDir)) return [];
  const files = fs.readdirSync(packagesDir).filter((f) => f.endsWith('.manifest.json'));
  const stores: LoadedPackageStore[] = [];

  for (const mf of files) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(packagesDir, mf), 'utf-8')
      ) as IngestedPackageManifest;
      const base = mf.replace(/\.manifest\.json$/, '');
      const chunksPath = path.join(packagesDir, `${base}.chunks.json`);
      const vectorsPath = path.join(packagesDir, `${base}.vectors.f32`);
      if (!fs.existsSync(chunksPath) || !fs.existsSync(vectorsPath)) continue;

      const chunks = JSON.parse(
        fs.readFileSync(chunksPath, 'utf-8')
      ) as IngestedPackageChunk[];
      const rawBuf = fs.readFileSync(vectorsPath);
      const aligned = new ArrayBuffer(rawBuf.byteLength);
      new Uint8Array(aligned).set(rawBuf);
      const vectors = new Float32Array(aligned);

      if (vectors.length !== chunks.length * manifest.dimensions) {
        continue;
      }

      stores.push({ manifest, chunks, vectors });
    } catch {
      // Skip corrupted store
    }
  }

  return stores;
}

export function deletePackageVectorStoreByConnector(
  packagesDir: string,
  connectorId: string
): boolean {
  if (!fs.existsSync(packagesDir)) return false;
  const stores = loadAllPackageVectorStores(packagesDir);
  const target = stores.find(
    (s) => s.manifest.connectorId === connectorId || s.manifest.id === connectorId
  );
  if (!target) return false;

  const id = target.manifest.id;
  for (const suffix of ['.manifest.json', '.chunks.json', '.vectors.f32']) {
    const p = path.join(packagesDir, `${id}${suffix}`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  return true;
}

export function discoverZipArchives(rootDir: string): DiscoveredZipArchive[] {
  const assetsDir = path.join(rootDir, 'public', 'assets', 'aistudio');
  if (!fs.existsSync(assetsDir)) return [];
  return fs
    .readdirSync(assetsDir)
    .filter((f) => f.toLowerCase().endsWith('.zip'))
    .sort()
    .map((fileName) => {
      const fullPath = path.join(assetsDir, fileName);
      const stat = fs.statSync(fullPath);
      return {
        fileName,
        relativePath: path.posix.join('public/assets/aistudio', fileName),
        bytes: stat.size,
      };
    });
}

/**
 * Fast vector + BM25 scoring against pre-computed Float32Array package embeddings.
 * Expects normalized vectors when queryVector.length === store.dimensions.
 */
export function scorePackageVectorStore(
  query: string,
  store: LoadedPackageStore,
  config: RouterConfig,
  queryVector: number[] | null,
  opts?: { topK?: number; minScore?: number }
): RagRetrievalMatch[] {
  const { manifest, chunks, vectors } = store;
  if (chunks.length === 0) return [];

  const topK = opts?.topK ?? 3;
  const dims = manifest.dimensions;
  const sameDim = Array.isArray(queryVector) && queryVector.length === dims;
  const minScore = opts?.minScore ?? (sameDim ? 0.35 : 0.12);

  // Normalize query vector once for fast dot product on normalized vectors
  let normQuery: Float32Array | null = null;
  if (sameDim && queryVector) {
    normQuery = new Float32Array(queryVector);
    normalizeVectorInPlace(normQuery, 0, dims);
  }

  const scored: RagRetrievalMatch[] = new Array(chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    let denseScore = 0;
    if (normQuery) {
      const base = i * dims;
      let dot = 0;
      for (let d = 0; d < dims; d++) {
        dot += normQuery[d] * vectors[base + d];
      }
      denseScore = Math.max(-1, Math.min(1, dot));
    } else if (queryVector && queryVector.length > 0 && config.mode !== 'sparse') {
      denseScore = cosineSimilarity(
        queryVector,
        computeLocalDenseVector(chunk.text, queryVector.length)
      );
    }

    const sparseScore = computeSparseSimilarity(query, chunk.text);
    const effectiveMode =
      !normQuery && (!queryVector || queryVector.length === 0) ? 'sparse' : config.mode;
    const score = blendScore(denseScore, sparseScore, effectiveMode, config.alpha);

    scored[i] = {
      chunkId: chunk.id,
      connectorId: chunk.connectorId,
      connectorName: chunk.connectorName,
      sourceUrl: `package://${manifest.sourceArchive}#${chunk.filePath}`,
      filePath: chunk.filePath,
      category: chunk.category,
      text: chunk.text,
      score: Math.round(score * 10000) / 10000,
      denseScore: Math.round(denseScore * 10000) / 10000,
      sparseScore: Math.round(sparseScore * 10000) / 10000,
    };
  }

  return scored
    .filter((m) => m.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
