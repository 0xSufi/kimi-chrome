import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';

const ROOT = __dirname;
const SRC = resolve(ROOT, 'src');
const OUT = resolve(ROOT, 'dist');

// ============================================================
// Content scripts (IIFE, no module imports)
// ============================================================

function contentScriptsPlugin(): Plugin {
  return {
    name: 'content-scripts',
    async writeBundle() {
      const { build } = await import('vite');
      const scripts = [
        { entry: 'src/content-scripts/accessibility-tree.ts', out: 'accessibility-tree.js' },
        { entry: 'src/content-scripts/agent-visual-indicator.ts', out: 'agent-visual-indicator.js' },
      ];
      for (const s of scripts) {
        if (!existsSync(s.entry)) continue;
        await build({
          configFile: false,
          publicDir: false,
          build: {
            lib: {
              entry: resolve(ROOT, s.entry),
              formats: ['iife'],
              name: 'ContentScript',
              fileName: () => s.out,
            },
            outDir: resolve(OUT, 'content-scripts'),
            emptyOutDir: false,
            minify: false,
            rollupOptions: { output: { extend: true } },
          },
          define: { 'process.env.NODE_ENV': '"production"' },
        });
      }
    },
  };
}

// ============================================================
// Manifest, HTML moves, and public/ asset passthrough
// ============================================================

function extensionAssetsPlugin(): Plugin {
  return {
    name: 'extension-assets',
    writeBundle() {
      const manifest = JSON.parse(readFileSync(resolve(SRC, 'manifest.json'), 'utf-8'));
      writeFileSync(resolve(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

      const htmlMoves: Record<string, string> = {
        'src/entrypoints/sidepanel/index.html': 'sidepanel.html',
        'src/entrypoints/options/index.html': 'options.html',
        'src/entrypoints/pairing/index.html': 'pairing.html',
        'src/entrypoints/offscreen/index.html': 'offscreen.html',
      };
      for (const [from, to] of Object.entries(htmlMoves)) {
        const p = resolve(OUT, from);
        if (existsSync(p)) copyFileSync(p, resolve(OUT, to));
      }
      const nestedSrc = resolve(OUT, 'src');
      if (existsSync(nestedSrc)) rmSync(nestedSrc, { recursive: true, force: true });

      const publicDir = resolve(ROOT, 'public');
      if (existsSync(publicDir)) copyDirRecursive(publicDir, OUT);
    },
  };
}

function copyDirRecursive(src: string, dest: string) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const sp = resolve(src, entry.name);
    const dp = resolve(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(sp, dp);
    else copyFileSync(sp, dp);
  }
}

// ============================================================
// Build config
// ============================================================

export default defineConfig(({ mode }) => ({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: mode === 'development' ? 'inline' : false,
    minify: mode === 'production',
    rollupOptions: {
      input: {
        'service-worker': resolve(SRC, 'service-worker.ts'),
        sidepanel: resolve(SRC, 'entrypoints/sidepanel/index.html'),
        options: resolve(SRC, 'entrypoints/options/index.html'),
        pairing: resolve(SRC, 'entrypoints/pairing/index.html'),
        offscreen: resolve(SRC, 'entrypoints/offscreen/index.html'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'service-worker') return 'service-worker.js';
          return '[name].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  resolve: { alias: { '@': SRC } },
  plugins: [contentScriptsPlugin(), extensionAssetsPlugin()],
}));
