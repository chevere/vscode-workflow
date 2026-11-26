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

  // Pele — loaded as a WebView static asset, not bundled
  fs.copyFileSync(
    path.join(__dirname, 'node_modules', 'pele', 'dist', 'pele.global.js'),
    path.join(vendorDir, 'pele.global.js')
  );

  // codicons — CSS + font required by WebView
  const codiconSrc = path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'dist');
  fs.copyFileSync(path.join(codiconSrc, 'codicon.css'), path.join(codiconsDir, 'codicon.css'));
  fs.copyFileSync(path.join(codiconSrc, 'codicon.ttf'), path.join(codiconsDir, 'codicon.ttf'));

  const graphIcon = fs.readFileSync(path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'src', 'icons', 'type-hierarchy.svg'), 'utf8');
  if (!graphIcon.includes('fill="currentColor"')) throw new Error('Unexpected type-hierarchy Codicon format');
  const attribution = '<!-- VS Code Codicons by Microsoft: https://github.com/microsoft/vscode-codicons, CC BY 4.0: https://creativecommons.org/licenses/by/4.0/; fill color modified. -->\n';
  fs.writeFileSync(path.join(codiconsDir, 'type-hierarchy-light.svg'), attribution + graphIcon.replace('fill="currentColor"', 'fill="#424242"'));
  fs.writeFileSync(path.join(codiconsDir, 'type-hierarchy-dark.svg'), attribution + graphIcon.replace('fill="currentColor"', 'fill="#c5c5c5"'));
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
