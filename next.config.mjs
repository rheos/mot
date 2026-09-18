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
  // Native modules — keep them external to the server bundle so Next does not try to
  // trace/bundle their .node binaries. better-sqlite3 (DB) and @node-rs/argon2 (password +
  // API-key hashing, pulled in via lib/auth.ts from the instrumentation boot hook) both ship
  // platform-specific binaries webpack cannot parse.
  // Next 15 renamed this from `experimental.serverComponentsExternalPackages`; under the old
  // key Next 15 ignored the whole list silently, so the config was asserting something untrue.
  serverExternalPackages: [
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
  // `experimental.instrumentationHook` is gone in Next 15 — instrumentation.ts is picked up by
  // default, so the flag is no longer needed (and is rejected as an unrecognized key).
  webpack: (config, { isServer, nextRuntime }) => {
    // `isServer` is true for BOTH server-side compilations: the nodejs server AND the
    // edge-server bundle. The edge bundle is middleware.ts *plus* instrumentation.ts, which
    // Next compiles for both runtimes — so instrumentation's node-only dynamic imports land
    // in the edge module graph even though register() returns early off the Edge runtime.
    // The two runtimes need different handling, and conflating them is what broke #32.
    if (!isServer) return config;

    // Native modules — external in BOTH runtimes. They ship .node binaries webpack cannot
    // parse. On edge they are only reachable from instrumentation code that never executes,
    // so a lazy commonjs require() here is inert.
    const NATIVE = ({ request }) =>
      request === 'better-sqlite3' ||
      request === 'bindings' ||
      request === '@node-rs/argon2' ||
      request.startsWith('@node-rs/argon2-') ||
      request === 'node-cron' ||
      // Track 5 (semantic retrieval) native deps. sqlite-vec ships a loadable extension
      // resolved at runtime via require.resolve from a platform sub-package
      // (sqlite-vec-{darwin,linux}-{x64,arm64} / -windows-x64); startsWith('sqlite-vec-')
      // covers every platform variant. fastembed pulls onnxruntime-node (+ onnxruntime-*
      // platform binaries) and @anush008/tokenizers, all carrying .node binaries.
      request === 'sqlite-vec' ||
      request.startsWith('sqlite-vec-') ||
      request === 'fastembed' ||
      request === '@anush008/tokenizers' ||
      request.startsWith('@anush008/tokenizers-') ||
      request.startsWith('onnxruntime');

    config.externals.unshift((ctx, callback) => {
      const { request } = ctx;
      if (NATIVE(ctx)) return callback(null, 'commonjs ' + request);
      // Node core modules. node-cron's ESM build imports bare 'path'/'fs' that only exist at
      // runtime, so the nodejs server still needs them external; edge needs care (below).
      if (NODE_BUILTINS.has(request)) {
        // nodejs server: externalize every builtin, bare or node:-prefixed.
        if (nextRuntime === 'nodejs') {
          return callback(null, 'commonjs ' + request.replace(/^node:/, ''));
        }
        // Edge: externalize ONLY the node:-scheme form. Those appear solely in
        // instrumentation's guarded imports, which never execute off the nodejs runtime, so
        // the require() is inert — and webpack cannot resolve a node: URI on its own
        // ("UnhandledSchemeError"), so it has to be externalized to build at all.
        //
        // Bare builtins are deliberately NOT externalized here: they come from middleware's
        // OWN graph (iron-session -> iron-webcrypto imports 'buffer'), which IS evaluated at
        // module load. Externalizing those emits a require() the Edge runtime rejects —
        // "Native module not found: buffer" — 500ing every request, including the
        // /api/status healthcheck, so the container never goes healthy and the deploy rolls
        // back. Left alone, webpack resolves them to its own browser polyfills. See #32.
        if (request.startsWith('node:')) {
          return callback(null, 'commonjs ' + request.slice('node:'.length));
        }
      }
      return callback();
    });

    return config;
  },
};

export default nextConfig;
