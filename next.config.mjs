/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // better-sqlite3 is a native module — keep it external to the server bundle
    // so Next does not try to trace/bundle the .node binary.
    serverComponentsExternalPackages: ['better-sqlite3', 'bindings'],
    // instrumentation.ts register() hook — server-side boot work runs once.
    instrumentationHook: true,
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      const externalize = ({ request }, callback) => {
        // Native module + its binding loader, plus any `node:`-scheme builtin that the
        // externalized chain pulls in (e.g. node:crypto), must load at runtime via
        // require(), not be bundled/parsed by webpack.
        if (
          request === 'better-sqlite3' ||
          request === 'bindings' ||
          request.startsWith('node:')
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
