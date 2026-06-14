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
// as before; with NEXT_PUBLIC_BASE_PATH=/mot (production, behind the Apache reverse proxy at
// example.com/mot) every route, asset, and route handler serves under /mot. Nothing is hardcoded —
// the same build runs at root or under a sub-path purely from this one env var.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Sub-path mount (empty string = root). basePath rewrites the app's own routes; assetPrefix
  // routes /_next/* asset URLs through the same prefix so they resolve behind the proxy.
  basePath,
  assetPrefix: basePath || undefined,
  // Self-contained server bundle (.next/standalone) so the app can ship without the full
  // node_modules tree — the production deploy runs `node .next/standalone/server.js`.
  output: 'standalone',
  experimental: {
    // Native modules — keep them external to the server bundle so Next does not try to
    // trace/bundle their .node binaries. better-sqlite3 (DB) and @node-rs/argon2 (password +
    // API-key hashing, pulled in via lib/auth.ts from the instrumentation boot hook) both ship
    // platform-specific binaries webpack cannot parse.
    serverComponentsExternalPackages: [
      'better-sqlite3',
      'bindings',
      '@node-rs/argon2',
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
