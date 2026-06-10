import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { ASSET_CONTENT_TYPES } from '../../shared/constants.ts'

// ----- MODULE-SCOPE CONSTANTS -----
// Resolve project root regardless of whether we're running from source or dist/.
// Use `import.meta.dirname` (Node22+ / Bun). `import.meta.dir` was Bun-only and is
// `undefined` under Node ESM, which made `resolve()` throw on plugin load.
const MODULE_DIR = resolve(import.meta.dirname, '../../../..')
const PROJECT_ROOT = MODULE_DIR.replace(/[\\/]dist$/, '')
const STATIC_DIR = join(PROJECT_ROOT, 'dist/web')

// Map of route key -> { body: Buffer, contentType }. We resolve once on plugin
// startup so HTTP requests are pure in-memory reads (no fs per request).
export async function buildStaticRoutes(): Promise<
  Map<string, { body: Buffer; contentType: string }>
> {
  const routes = new Map<string, { body: Buffer; contentType: string }>()
  if (!existsSync(STATIC_DIR)) {
    // Web UI hasn't been built. Server can still run for API/WS but won't serve UI.
    return routes
  }
  const files = readdirSync(STATIC_DIR, { recursive: true })
  for (const file of files) {
    if (typeof file === 'string' && !statSync(join(STATIC_DIR, file)).isDirectory()) {
      const ext = extname(file)
      const routeKey = `/${file.replace(/\\/g, '/')}` // e.g., /assets/js/bundle.js
      const fullPath = join(STATIC_DIR, file)
      const contentType = ASSET_CONTENT_TYPES[ext] || 'application/octet-stream'
      const body = readFileSync(fullPath)
      routes.set(routeKey, { body, contentType })
    }
  }
  return routes
}
