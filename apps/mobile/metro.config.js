/* global require, module, __dirname */
// Metro loads this configuration as CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Metro cannot resolve the dynamic require calls in jsonc-parser's UMD entry.
// Use the ESM entry provided by the same installed package instead.
config.resolver.resolveRequest = (context, moduleName, platform) =>
  context.resolveRequest(
    context,
    moduleName === 'jsonc-parser' ? 'jsonc-parser/lib/esm/main.js' : moduleName,
    platform,
  );

module.exports = config;
