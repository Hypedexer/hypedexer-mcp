import pkg from '../package.json' with { type: 'json' }

/**
 * Single source of truth for the published version. tsup inlines the JSON at
 * build time, so dist always carries the version package.json had when built
 * (prepublishOnly rebuilds after the release bump).
 */
export const VERSION: string = pkg.version
