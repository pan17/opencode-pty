import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { OpencodeClient } from '@opencode-ai/sdk'
import {
  initManager,
  manager,
  rawOutputCallbacks,
  registerRawOutputCallback,
} from '../src/plugin/pty/manager.ts'
import { portableNode, KEEP_ALIVE_ECHO_SCRIPT } from './utils.ts'
import type { Subprocess } from 'bun'

describe('PTY Echo Behavior', () => {
  beforeEach(() => {
    initManager(new OpencodeClient())
  })

  afterEach(() => {
    manager.clearAllSessions()
  })

  class TestSpawner {
    readonly subprocess: Subprocess<'ignore', 'pipe', 'pipe'>
    stderrOutput = ''
    stdoutOutput = ''
    readonly testNumber: number
    constructor(testNumber: number) {
      this.testNumber = testNumber
      this.subprocess = Bun.spawn({
        cmd: [
          'bun',
          'test',
          'spawn-repeat.test.ts',
          '--test-name-pattern',
          'should receive initial data once',
        ],
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, SYNC_TESTS: '1' },
      })

      const { stdout, stderr } = this.subprocess

      ;(async () => {
        const decoder = new TextDecoder()
        const reader = stderr.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            this.stderrOutput += decoder.decode(value, { stream: true })
            if (done) break
          }
          this.stderrOutput += decoder.decode()
        } finally {
          reader.releaseLock()
        }
      })()
      ;(async () => {
        const decoder = new TextDecoder()
        const reader = stdout.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            this.stdoutOutput += decoder.decode(value, { stream: true })
            if (done) break
          }
          this.stdoutOutput += decoder.decode()
        } finally {
          reader.releaseLock()
        }
      })()
    }
  }

  it('should receive initial data reproducibly', async () => {
    const start = Date.now()
    const maxRuntime = 1000
    let runnings = 1
    const spawned: TestSpawner[] = []
    while (Date.now() - start < maxRuntime) {
      runnings++
      const testSpawner = new TestSpawner(runnings)
      spawned.push(testSpawner)
    }
    let errorMessage = ''
    errorMessage += `[TEST] Spawned ${runnings} subprocesses in ${Date.now() - start}ms.\n`
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 20000)
    })
    const all = Promise.all(spawned.map((s) => s.subprocess.exited))
    await Promise.race([all, timeout])
    const stillRunning = spawned.filter((s) => s.subprocess.exitCode === null)
    if (stillRunning.length > 0) {
      errorMessage += `[TEST] Timeout reached after 20s with ${stillRunning.length} subprocesses still running.\n`
      stillRunning.forEach((s) => {
        errorMessage += `[TEST] Subprocess ${s.testNumber} stderr: ${s.stderrOutput}\n`
        errorMessage += `[TEST] Subprocess ${s.testNumber} stdout: ${s.stdoutOutput}\n`
      })
    }
    const exitCodeNonZero = spawned.filter(
      (s) => s.subprocess.exitCode !== null && s.subprocess.exitCode !== 0
    )
    if (exitCodeNonZero.length > 0) {
      errorMessage += `[TEST] ${exitCodeNonZero.length} subprocesses exited with non-zero exit code.\n`
      exitCodeNonZero.forEach((s) => {
        errorMessage += `[TEST] Subprocess ${s.testNumber} stderr: ${s.stderrOutput}\n`
        errorMessage += `[TEST] Subprocess ${s.testNumber} stdout: ${s.stdoutOutput}\n`
      })
    }
    expect(stillRunning.length + exitCodeNonZero.length, errorMessage).toBe(0)
  }, 60000)

  it.skipIf(!process.env.SYNC_TESTS)(
    'should receive initial data once',
    async () => {
      const title = crypto.randomUUID()
      const promise = new Promise<string>((resolve, reject) => {
        let rawDataTotal = ''
        registerRawOutputCallback((session, rawData) => {
          if (session.title !== title) return
          rawDataTotal += rawData
          if (rawData.includes('Hello World')) {
            resolve(rawDataTotal)
          }
        })
        setTimeout(() => {
          reject(new Error(`Timeout waiting for Hello World, received: ${rawDataTotal}`))
        }, 10000)
      })

      const { command, args } = portableNode(KEEP_ALIVE_ECHO_SCRIPT)

      const session = manager.spawn({
        title: title,
        command,
        args,
        description: 'Echo test session',
        parentSessionId: 'test',
      })

      const rawData = await promise
      expect(rawData).toContain('Hello World')

      manager.kill(session.id, true)
      rawOutputCallbacks.length = 0

      expect(rawData).toContain('Hello World')
    },
    10000
  )
})
