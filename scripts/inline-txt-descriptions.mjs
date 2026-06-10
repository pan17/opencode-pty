// One-time script to convert .txt tool descriptions to .ts files for Node ESM compat.
// Run with: node scripts/inline-txt-descriptions.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const toolsDir = join(here, '..', 'src', 'plugin', 'pty', 'tools')

const files = ['spawn', 'write', 'read', 'list', 'kill']

for (const name of files) {
 const txtPath = join(toolsDir, `${name}.txt`)
 const tsPath = join(toolsDir, `${name}-description.ts`)
 const content = readFileSync(txtPath, 'utf8')
 // Escape backticks and ${ for safe embedding in a template literal
 const escaped = content.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
 const exportStmt = `export const ${name.toUpperCase()}_DESCRIPTION = \`${escaped}\`\n`
 writeFileSync(tsPath, exportStmt, 'utf8')
 console.log(`Wrote ${tsPath}`)
}
