import { builtinModules } from 'node:module';

// Node core modules, both bare ('path') and prefixed ('node:path'). Some server-only deps
// (e.g. node-cron's ESM build) import the bare form, which webpack tries to resolve for the
// browser-ish server bundle and fails on. We externalize every core module so they load via
// runtime require() instead.
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

// Sub-path deploy support. With NO env var (local dev, tests, CI) the app runs at root exactly
// as before; with NEXT_PUBLIC_BASE_PATH=/mot (production, behind a reverse proxy) every route,
// asset, and route handler serves under /mot. Nothing is hardcoded —
// the same build runs at root or under a sub-path purely from this one env var.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Sub-path mount (empty string = root). basePath rewrites the app's own routes; assetPrefix
  // routes /_next/* asset URLs through the same prefix so they resolve behind the proxy.
  basePath,
  assetPrefix: basePath || undefined,
  // NO standalone output. Production runs `next start`, which is INCOMPATIBLE with
  // `output: 'standalone'` — that pairing silently fails to register newly-added routes (Next
  // logs "next start does not work with output: standalone"), so old pages serve but a new route
  // 404s. The container gets full node_modules from the build's `npm ci`, so the self-contained
  // bundle bought nothing here anyway.
  // The container command is `npm start -- -H 0.0.0.0 -p 3100`, run by Coolify from the Nixpacks
  // image. (This used to be a systemd mot.service on Lightsail; that host is gone, so do not go
  // looking for an ExecStart to edit.) If this is ever switched back to standalone, the start
  // command MUST switch to `node .next/standalone/server.js` and the build MUST copy
  // .next/static + public into it.
  experimental: {
    // Native modules — keep them external to the server bundle so Next does not try to
    // trace/bundle their .node binaries. better-sqlite3 (DB) and @node-rs/argon2 (password +
    // API-key hashing, pulled in via lib/auth.ts from the instrumentation boot hook) both ship
    // platform-specific binaries webpack cannot parse.
    serverComponentsExternalPackages: [
      'better-sqlite3',
      'bindings',
      '@node-rs/argon2',
      // Track 5 (semantic retrieval): fastembed pulls onnxruntime-node + @anush008/tokenizers
      // (both ship .node binaries); sqlite-vec ships a platform-specific loadable extension.
      // Keep all four external so Next never traces/bundles their native artifacts.
      'fastembed',
      'onnxruntime-node',
      '@anush008/tokenizers',
      'sqlite-vec',
    ],
    // instrumentation.ts register() hook — server-side boot work runs once.
    instrumentationHook: true,
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      const externalize = ({ request }, callback) => {
        // Native modules + their binding loader, and any Node core module (bare or node:-scheme)
        // the externalized chain pulls in, must load at runtime via require(), not be
        // bundled/parsed by webpack. @node-rs/argon2 resolves to a platform-specific .node binary
        // (argon2.darwin-x64.node etc.); node-cron's ESM build imports bare 'path'/'fs' that only
        // exist at runtime — both must stay external.
        if (
          request === 'better-sqlite3' ||
          request === 'bindings' ||
          request === '@node-rs/argon2' ||
          request.startsWith('@node-rs/argon2-') ||
          request === 'node-cron' ||
          // Track 5 (semantic retrieval) native deps. sqlite-vec ships a loadable extension
          // resolved at runtime via require.resolve from a platform sub-package
          // (sqlite-vec-{darwin,linux}-{x64,arm64} / -windows-x64); startsWith('sqlite-vec-')
          // covers every platform variant, including this box's darwin-x64. fastembed pulls
          // onnxruntime-node (+ onnxruntime-* platform binaries) and @anush008/tokenizers,
          // all of which carry .node binaries webpack cannot parse.
          request === 'sqlite-vec' ||
          request.startsWith('sqlite-vec-') ||
          request === 'fastembed' ||
          request === '@anush008/tokenizers' ||
          request.startsWith('@anush008/tokenizers-') ||
          request.startsWith('onnxruntime') ||
          NODE_BUILTINS.has(request)
        ) {
          return callback(null, 'commonjs ' + request.replace(/^node:/, ''));
        }
        return callback();
      };
      config.externals.unshift(externalize);
    }
    return config;
  },
};

export default nextConfig;
