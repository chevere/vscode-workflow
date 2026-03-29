// @ts-check
'use strict';

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

/** @type {import('esbuild').BuildOptions} */
const base = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  minify,
  sourcemap: !minify,
};

function copyVendorAssets() {
  const vendorDir = path.join(__dirname, 'dist', 'vendor');
  const codiconsDir = path.join(vendorDir, 'codicons');
  fs.mkdirSync(codiconsDir, { recursive: true });

  // mermaid — loaded as a WebView static asset, not bundled
  fs.copyFileSync(
    path.join(__dirname, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
    path.join(vendorDir, 'mermaid.min.js')
  );

  // codicons — CSS + font required by WebView
  const codiconSrc = path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'dist');
  fs.copyFileSync(path.join(codiconSrc, 'codicon.css'), path.join(codiconsDir, 'codicon.css'));
  fs.copyFileSync(path.join(codiconSrc, 'codicon.ttf'), path.join(codiconsDir, 'codicon.ttf'));
}

async function main() {
  copyVendorAssets();

  /** @type {import('esbuild').BuildOptions} */
  const clientConfig = {
    ...base,
    entryPoints: ['client/src/extension.ts'],
    outfile: 'client/out/extension.js',
    external: ['vscode'],
  };

  /** @type {import('esbuild').BuildOptions} */
  const serverConfig = {
    ...base,
    entryPoints: ['server/src/server.ts'],
    outfile: 'server/out/server.js',
  };

  if (watch) {
    const [clientCtx, serverCtx] = await Promise.all([
      esbuild.context(clientConfig),
      esbuild.context(serverConfig),
    ]);
    await Promise.all([clientCtx.watch(), serverCtx.watch()]);
    console.log('[esbuild] watching…');
  } else {
    await Promise.all([esbuild.build(clientConfig), esbuild.build(serverConfig)]);
    console.log('[esbuild] done');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
