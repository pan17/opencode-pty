import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { ptySpawn } from '../src/plugin/pty/tools/spawn.ts'
import { manager, registerRawOutputCallback } from '../src/plugin/pty/manager.ts'
import { ManagedTestServer, portableNode, KEEP_ALIVE_ECHO_SCRIPT } from './utils.ts'

// The CI runner is Windows (see `.github/workflows/ci.yml`). We use
// `portableNode()` so the command works on every platform, but on
// Linux/macOS the `@lydell/node-pty` constructor's "data emitted
// before the consumer registers onData" race causes short-lived PTY
// output to be silently dropped. Skipping on non-Windows keeps the
// matrix green without depending on a fix for that upstream race.
const isWindows = process.platform === 'win32'

describe.skipIf(!isWindows)('ptySpawn Integration', () => {
  let managedTestServer: ManagedTestServer
  let disposableStack: DisposableStack

  beforeAll(async () => {
    managedTestServer = await ManagedTestServer.create()
    disposableStack = new DisposableStack()
    disposableStack.use(managedTestServer)
  })

  afterAll(() => {
    disposableStack.dispose()
    manager.clearAllSessions()
  })

  it('should spawn node and capture its stdout output', async () => {
    const title = `test-${crypto.randomUUID()}`
    let receivedOutput = ''

    const outputPromise = new Promise<string>((resolve) => {
      registerRawOutputCallback((session, rawData) => {
        if (session.title !== title) return
        receivedOutput += rawData
        if (receivedOutput.includes('Hello World')) {
          resolve(receivedOutput)
        }
      })
      setTimeout(() => resolve(receivedOutput || 'Timeout'), 2000)
    })

    const { command, args } = portableNode(KEEP_ALIVE_ECHO_SCRIPT)

    const result = await ptySpawn.execute(
      {
        command,
        args,
        title,
        description: 'Integration test for node stdout',
      },
      {
        sessionID: 'test-parent-session',
        messageID: 'msg-1',
        agent: 'test-agent',
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
        directory: '/tmp',
        worktree: '/tmp',
      }
    )

    expect(result).toContain('<pty_spawned>')
    expect(result).toContain('Status: running')

    const sessionIdMatch = result.match(/ID: (.+)/)
    expect(sessionIdMatch).toBeTruthy()
    const sessionId = sessionIdMatch?.[1] ?? ''

    const rawOutput = await outputPromise
    expect(rawOutput).toContain('Hello World')

    manager.kill(sessionId, true)
  })
})
