const { defineConfig } = require('@vscode/test-cli');
const path = require('path');

module.exports = defineConfig({
    files: 'src/test/**/*.test.js',
    extensionDevelopmentPath: path.resolve(__dirname, '..'),
});
