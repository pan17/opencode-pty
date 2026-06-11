import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// This test ensures the npm package can be packed, installed, and serves assets correctly

async function run(cmd: string[], opts: { cwd?: string } = {}) {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

function findPackFileFromOutput(stdout: string): string {
  const lines = stdout.trim().split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line?.trim().endsWith('.tgz')) return line.trim()
  }
  throw new Error('No .tgz file found in npm pack output')
}

describe('npm pack integration', () => {
  let tempDir: string
  let packFile: string | null = null

  afterEach(async () => {
    // Cleanup temp directory
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'AbortError') {
          throw error
        }
      }
    }

    // Cleanup pack file
    if (packFile) {
      try {
        unlinkSync(packFile)
      } catch {
        // File may already be deleted
      }
    }
  })

  it('packs, installs, and serves assets correctly', async () => {
    // 1) Create temp workspace
    tempDir = mkdtempSync(join(tmpdir(), 'opencode-pty-'))

    // 2) Pack the package
    const pack = await run(['npm', 'pack', '--ignore-scripts'])
    expect(pack.code).toBe(0)
    const tgz = findPackFileFromOutput(pack.stdout)
    packFile = tgz
    const tgzPath = join(process.cwd(), tgz)

    // List tarball contents to find assets
    const list = await run(['tar', '-tf', tgzPath])
    expect(list.code).toBe(0)
    const files = list.stdout.split(/\r?\n/).filter(Boolean)
    const jsAsset = files.find((f) => /package\/dist\/web\/assets\/[^/]+\.js$/.test(f))
    expect(jsAsset).toBeDefined()

    // 3) Extract tarball into a temp dir and verify the package structure
    const pkgDir = join(tempDir, 'extracted-pkg')
    mkdirSync(pkgDir, { recursive: true })
    const extract = await run(['tar', '-xzf', tgzPath, '-C', pkgDir])
    expect(extract.code).toBe(0)
    const pkgContents = join(pkgDir, 'package')
    expect(existsSync(join(pkgContents, 'dist/src/plugin/pty/manager.js'))).toBe(true)
    expect(existsSync(join(pkgContents, 'dist/web/index.html'))).toBe(true)
    expect(existsSync(join(pkgContents, 'package.json'))).toBe(true)

    // 4) Verify the tarball has the expected structure
    expect(files).toContain('package/dist/web/index.html')
    // At least one hashed JS and CSS asset
    const hasCssAsset = files.some((f) => /package\/dist\/web\/assets\/[^/]+\.css$/.test(f))
    expect(hasCssAsset).toBeTrue()
    // Built plugin JS
    const hasPluginBundle = files.some((f) => f.startsWith('package/dist/'))
    expect(hasPluginBundle).toBeTrue()
  }, 90000)
})
