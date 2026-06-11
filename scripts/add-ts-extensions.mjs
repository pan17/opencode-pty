// One-time script: add .ts extension to all relative imports in src/ that lack one.
// After this, tsc with rewriteRelativeImportExtensions will emit .js extensions in dist/,
// making the bundle loadable under Node ESM (not just Bun).
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', 'src')

// Match: import ... from './rel/path' OR import('rel/path')
// Without trailing .ts/.js
const importRe = /(from\s+['"])(\.\.?\/[^'"]+?)(['"])/g

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (extname(p) === '.ts') yield p
  }
}

let touched = 0
for (const file of walk(root)) {
  const orig = readFileSync(file, 'utf8')
  const updated = orig.replace(importRe, (m, pre, rel, post) => {
    // Don't touch already-extended or non-relative
    if (rel.endsWith('.ts') || rel.endsWith('.js')) return m
    if (rel.endsWith('.json')) return m
    // Only handle relative imports starting with ./
    return `${pre}${rel}.ts${post}`
  })
  if (updated !== orig) {
    writeFileSync(file, updated, 'utf8')
    touched++
    console.log(`Updated: ${file}`)
  }
}
console.log(`Done. ${touched} file(s) updated.`)
