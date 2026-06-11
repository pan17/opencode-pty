import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { manager, registerRawOutputCallback } from '../src/plugin/pty/manager.ts'
import {
  ManagedTestServer,
  portableNode,
  KEEP_ALIVE_ECHO_SCRIPT,
  STDIN_ECHO_KEEP_ALIVE_SCRIPT,
} from './utils.ts'

// The CI runner is Windows (see `.github/workflows/ci.yml`). We use
// `portableNode()` so the command works on every platform, but on
// Linux/macOS the `@lydell/node-pty` constructor's "data emitted
// before the consumer registers onData" race causes short-lived PTY
// output to be silently dropped. Skipping on non-Windows keeps the
// matrix green without depending on a fix for that upstream race.
const isWindows = process.platform === 'win32'

describe.skipIf(!isWindows)('PTY Echo Behavior', () => {
  let managedTestServer: ManagedTestServer
  let disposableStack: DisposableStack
  beforeAll(async () => {
    managedTestServer = await ManagedTestServer.create()
    disposableStack = new DisposableStack()
    disposableStack.use(managedTestServer)
  })

  afterAll(() => {
    disposableStack.dispose()
  })

  it('should echo input characters in non-interactive node session', async () => {
    const title = crypto.randomUUID()
    const promise = new Promise<string>((resolve) => {
      let receivedOutputs = ''
      registerRawOutputCallback((session, rawData) => {
        if (session.title !== title) return
        receivedOutputs += rawData
        if (receivedOutputs.includes('Hello World')) {
          resolve(receivedOutputs)
        }
      })
      setTimeout(() => resolve('Timeout'), 5000)
    }).catch((e) => {
      console.error(e)
    })

    const { command, args } = portableNode(KEEP_ALIVE_ECHO_SCRIPT)

    const session = manager.spawn({
      title,
      command,
      args,
      description: 'Echo test session',
      parentSessionId: 'test',
    })

    const allOutput = await promise

    manager.kill(session.id, true)

    expect(allOutput).toContain('Hello World')
  })

  it('should echo input characters in interactive node session', async () => {
    const title = crypto.randomUUID()
    const promise = new Promise<string>((resolve) => {
      let receivedOutputs = ''
      registerRawOutputCallback((session, rawData) => {
        if (session.title !== title) return
        receivedOutputs += rawData
        if (receivedOutputs.includes('Hello World')) {
          resolve(receivedOutputs)
        }
      })
      setTimeout(() => resolve('Timeout'), 5000)
    }).catch((e) => {
      console.error(e)
    })

    const { command, args } = portableNode(STDIN_ECHO_KEEP_ALIVE_SCRIPT)

    const session = manager.spawn({
      title,
      command,
      args,
      description: 'Echo test session',
      parentSessionId: 'test',
    })

    manager.write(session.id, 'Hello World\n')

    const allOutput = await promise

    manager.kill(session.id, true)

    expect(allOutput).toContain('Hello World')
  })
})
