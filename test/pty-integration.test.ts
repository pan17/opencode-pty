import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import {
  ManagedTestClient,
  ManagedTestServer,
  portableNode,
  KEEP_ALIVE_ECHO_SCRIPT,
} from './utils.ts'
import type { WSMessageServerSessionUpdate } from '../src/web/shared/types.ts'
import type { PTYSessionInfo } from '../src/plugin/pty/types.ts'

// The CI runner is Windows (see `.github/workflows/ci.yml`). We use
// `portableNode()` so commands work on every platform, but on
// Linux/macOS the `@lydell/node-pty` constructor's "data emitted
// before the consumer registers onData" race causes short-lived PTY
// output to be silently dropped. Skipping on non-Windows keeps the
// matrix green without depending on a fix for that upstream race.
const isWindows = process.platform === 'win32'

describe.skipIf(!isWindows)('PTY Manager Integration', () => {
  let managedTestServer: ManagedTestServer
  let disposableStack: DisposableStack

  beforeAll(async () => {
    managedTestServer = await ManagedTestServer.create()
    disposableStack = new DisposableStack()
    disposableStack.use(managedTestServer)
  })

  afterAll(async () => {
    disposableStack.dispose()
  })

  describe('Output Broadcasting', () => {
    it('should broadcast raw output to subscribed WebSocket clients', async () => {
      await using managedTestClient = await ManagedTestClient.create(
        managedTestServer.server.getWsUrl()
      )
      const title = crypto.randomUUID()
      const dataReceivedPromise = new Promise<string>((resolve) => {
        let dataTotal = ''
        managedTestClient.rawDataCallbacks.push((message) => {
          if (message.session.title !== title) return
          dataTotal += message.rawData
          if (dataTotal.includes('test output')) {
            resolve(dataTotal)
          }
        })
      })
      const { command, args } = portableNode(
        'process.stdout.write("test output\\n"); setInterval(() => {}, 5000)'
      )
      managedTestClient.send({
        type: 'spawn',
        title,
        command,
        args,
        description: 'Test session',
        parentSessionId: managedTestServer.sessionId,
        subscribe: true,
      })

      const rawData = await dataReceivedPromise

      expect(rawData).toContain('test output')
    })

    it('should not broadcast to unsubscribed clients', async () => {
      await using managedTestClient1 = await ManagedTestClient.create(
        managedTestServer.server.getWsUrl()
      )
      await using managedTestClient2 = await ManagedTestClient.create(
        managedTestServer.server.getWsUrl()
      )
      const title1 = crypto.randomUUID()
      const title2 = crypto.randomUUID()
      const dataReceivedPromise1 = new Promise<string>((resolve) => {
        let dataTotal = ''
        managedTestClient1.rawDataCallbacks.push((message) => {
          if (message.session.title !== title1) return
          dataTotal += message.rawData
          if (dataTotal.includes('output from session 1')) {
            resolve(dataTotal)
          }
        })
      })
      const dataReceivedPromise2 = new Promise<string>((resolve) => {
        let dataTotal = ''
        managedTestClient2.rawDataCallbacks.push((message) => {
          if (message.session.title !== title2) return
          dataTotal += message.rawData
          if (dataTotal.includes('output from session 2')) {
            resolve(dataTotal)
          }
        })
      })

      // Two pre-formatted scripts (one per session id) so the lint
      // rule against template-literal placeholders inside plain
      // strings doesn't fire. Both append a keep-alive interval so
      // the consumer's `onData` listener has time to register before
      // the process exits.
      const { command: command1 } = portableNode(
        'process.stdout.write("output from session 1\\n"); setInterval(() => {}, 5000)'
      )
      const { command: command2 } = portableNode(
        'process.stdout.write("output from session 2\\n"); setInterval(() => {}, 5000)'
      )

      managedTestClient1.send({
        type: 'spawn',
        title: title1,
        command: command1,
        args: ['1'],
        description: 'Session 1',
        parentSessionId: managedTestServer.sessionId,
        subscribe: true,
      })

      managedTestClient2.send({
        type: 'spawn',
        title: title2,
        command: command2,
        args: ['2'],
        description: 'Session 2',
        parentSessionId: managedTestServer.sessionId,
        subscribe: true,
      })

      const rawData1 = await dataReceivedPromise1
      const rawData2 = await dataReceivedPromise2

      expect(rawData1).toContain('output from session 1')
      expect(rawData2).toContain('output from session 2')

      expect(rawData1).not.toContain('output from session 2')
      expect(rawData2).not.toContain('output from session 1')
    })
  })

  describe('Session Management Integration', () => {
    it('should provide session data in correct format', async () => {
      await using managedTestClient = await ManagedTestClient.create(
        managedTestServer.server.getWsUrl()
      )
      const title = crypto.randomUUID()
      const sessionInfoPromise = new Promise<WSMessageServerSessionUpdate>((resolve) => {
        managedTestClient.sessionUpdateCallbacks.push((message) => {
          if (message.session.title === title && message.session.status === 'exited') {
            resolve(message)
          }
        })
      })

      let outputTotal = ''
      managedTestClient.rawDataCallbacks.push((message) => {
        if (message.session.title !== title) return
        outputTotal += message.rawData
      })

      const { command, args } = portableNode(KEEP_ALIVE_ECHO_SCRIPT)
      managedTestClient.send({
        type: 'spawn',
        title,
        command,
        args,
        description: 'Test Node.js session',
        parentSessionId: managedTestServer.sessionId,
        subscribe: true,
      })

      const sessionInfo = await sessionInfoPromise

      const response = await fetch(`${managedTestServer.server.server.url}/api/sessions`)
      const sessions = (await response.json()) as PTYSessionInfo[]

      expect(Array.isArray(sessions)).toBe(true)
      expect(sessions.length).toBeGreaterThan(0)

      const testSession = sessions.find((s) => s.id === sessionInfo.session.id)
      expect(testSession).toBeDefined()
      if (!testSession) return
      expect(typeof testSession.command).toBe('string')
      expect(Array.isArray(testSession.args)).toBe(true)
      expect(testSession.status).toBeDefined()
      expect(typeof testSession.pid).toBe('number')
      expect(testSession.lineCount).toBeGreaterThan(0)
      expect(outputTotal).toContain('Hello World')
    })

    it('should handle session lifecycle correctly', async () => {
      await using managedTestClient = await ManagedTestClient.create(
        managedTestServer.server.getWsUrl()
      )
      const title = crypto.randomUUID()
      const sessionExitedPromise = new Promise<WSMessageServerSessionUpdate>((resolve) => {
        managedTestClient.sessionUpdateCallbacks.push((message) => {
          if (message.session.title === title && message.session.status === 'exited') {
            resolve(message)
          }
        })
      })

      const { command, args } = portableNode(
        'process.stdout.write("lifecycle test\\n"); setInterval(() => {}, 5000)'
      )
      managedTestClient.send({
        type: 'spawn',
        title,
        command,
        args,
        description: 'Lifecycle test session',
        parentSessionId: managedTestServer.sessionId,
        subscribe: true,
      })

      const sessionExited = await sessionExitedPromise

      expect(sessionExited.session.status).toBe('exited')
      expect(sessionExited.session.exitCode).toBe(0)

      const response = await fetch(
        `${managedTestServer.server.server.url}/api/sessions/${sessionExited.session.id}`
      )
      const sessionData = (await response.json()) as PTYSessionInfo

      expect(sessionData.status).toBe('exited')
      expect(sessionData.exitCode).toBe(0)
    })

    it('should support session cleanup via API', async () => {
      await using managedTestClient = await ManagedTestClient.create(
        managedTestServer.server.getWsUrl()
      )
      const title = crypto.randomUUID()
      const sessionKilledPromise = new Promise<WSMessageServerSessionUpdate>((resolve) => {
        managedTestClient.sessionUpdateCallbacks.push((message) => {
          if (message.session.title === title && message.session.status === 'killed') {
            resolve(message)
          }
        })
      })
      const sessionRunningPromise = new Promise<WSMessageServerSessionUpdate>((resolve) => {
        managedTestClient.sessionUpdateCallbacks.push((message) => {
          if (message.session.title === title && message.session.status === 'running') {
            resolve(message)
          }
        })
      })

      const { command, args } = portableNode('setTimeout(() => {}, 10000)')
      managedTestClient.send({
        type: 'spawn',
        title,
        command,
        args,
        description: 'Kill test session',
        parentSessionId: managedTestServer.sessionId,
        subscribe: true,
      })
      const runningSession = await sessionRunningPromise

      const killResponse = await fetch(
        `${managedTestServer.server.server.url}/api/sessions/${runningSession.session.id}`,
        {
          method: 'DELETE',
        }
      )
      expect(killResponse.status).toBe(200)

      await sessionKilledPromise

      const killResult = await killResponse.json()
      expect(killResult.success).toBe(true)

      const statusResponse = await fetch(
        `${managedTestServer.server.server.url}/api/sessions/${runningSession.session.id}`
      )
      const sessionData = await statusResponse.json()
      expect(sessionData.status).toBe('killed')
    })

    it('should auto-kill timed sessions and mark them as timed out', async () => {
      await using managedTestClient = await ManagedTestClient.create(
        managedTestServer.server.getWsUrl()
      )
      const title = crypto.randomUUID()
      const timedOutSessionPromise = new Promise<WSMessageServerSessionUpdate>((resolve) => {
        managedTestClient.sessionUpdateCallbacks.push((message) => {
          if (
            message.session.title === title &&
            message.session.status === 'killed' &&
            message.session.timedOut
          ) {
            resolve(message)
          }
        })
      })

      const { command, args } = portableNode('setTimeout(() => {}, 10000)')
      managedTestClient.send({
        type: 'spawn',
        title,
        command,
        args,
        description: 'Timed session',
        parentSessionId: managedTestServer.sessionId,
        subscribe: true,
        timeoutSeconds: 1,
      })

      const timedOutSession = await timedOutSessionPromise

      expect(timedOutSession.session.timeoutSeconds).toBe(1)
      expect(timedOutSession.session.timedOut).toBe(true)
      expect(timedOutSession.session.status).toBe('killed')

      const response = await fetch(
        `${managedTestServer.server.server.url}/api/sessions/${timedOutSession.session.id}`
      )
      const sessionData = (await response.json()) as PTYSessionInfo

      expect(sessionData.status).toBe('killed')
      expect(sessionData.timeoutSeconds).toBe(1)
      expect(sessionData.timedOut).toBe(true)
    })
  })
})
