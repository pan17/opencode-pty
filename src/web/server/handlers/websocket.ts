import { inspect } from 'node:util'
import { manager } from '../../../plugin/pty/manager.ts'
import {
  type WSMessageServerSessionList,
  type WSMessageClientSubscribeSession,
  type WSMessageServerError,
  type WSMessageClientUnsubscribeSession,
  type WSMessageClientSessionList,
  type WSMessageClient,
  type WSMessageClientSpawnSession,
  type WSMessageClientInput,
  type WSMessageClientReadRaw,
  type WSMessageServerReadRawResponse,
  type WSMessageServerSubscribedSession,
  CustomError,
  type WSMessageServerUnsubscribedSession,
} from '../../shared/types.ts'

// SubscriberWebSocket mirrors the shape used in server.ts. We re-declare the
// minimal subset we need here so this module stays usable without an import cycle.
type SubscriberWebSocket = {
  send(data: string): void
  subscribe(topic: string): void
  unsubscribe(topic: string): void
}

class WebSocketHandler {
  private sendSessionList(ws: SubscriberWebSocket): void {
    const sessions = manager.list()
    const message: WSMessageServerSessionList = { type: 'session_list', sessions }
    ws.send(JSON.stringify(message))
  }

  private handleSubscribe(ws: SubscriberWebSocket, message: WSMessageClientSubscribeSession): void {
    const session = manager.get(message.sessionId)
    if (!session) {
      const error: WSMessageServerError = {
        type: 'error',
        error: new CustomError(`Session ${message.sessionId} not found`),
      }
      ws.send(JSON.stringify(error))
    } else {
      ws.subscribe(`session:${message.sessionId}`)
      const response: WSMessageServerSubscribedSession = {
        type: 'subscribed',
        sessionId: message.sessionId,
      }
      ws.send(JSON.stringify(response))
    }
  }

  private handleUnsubscribe(
    ws: SubscriberWebSocket,
    message: WSMessageClientUnsubscribeSession
  ): void {
    const topic = `session:${message.sessionId}`
    ws.unsubscribe(topic)
    const response: WSMessageServerUnsubscribedSession = {
      type: 'unsubscribed',
      sessionId: message.sessionId,
    }
    ws.send(JSON.stringify(response))
  }

  private handleSessionListRequest(
    ws: SubscriberWebSocket,
    _message: WSMessageClientSessionList
  ): void {
    this.sendSessionList(ws)
  }

  private handleUnknownMessage(ws: SubscriberWebSocket, message: WSMessageClient): void {
    const error: WSMessageServerError = {
      type: 'error',
      error: new CustomError(`Unknown message type ${message.type}`),
    }
    ws.send(JSON.stringify(error))
  }

  public handleWebSocketMessage(
    ws: SubscriberWebSocket,
    data: string | Buffer | ArrayBuffer | Buffer[]
  ): void {
    // The `ws` library delivers message payloads as `Buffer` by default
    // (the type signature on `WebSocket.on('message', …)` is
    // `(data: RawData, isBinary: boolean) => void` where `RawData` is
    // `Buffer | ArrayBuffer | Buffer[]`). The Node ESM port was
    // previously casting every frame to `string` before reaching this
    // handler — which works on Bun/Linux but produces a `Buffer` on
    // Bun/Windows (different `WebSocket` implementation), making
    // `typeof data !== 'string'` true and silently replying with
    // "Binary messages are not supported yet" instead of the real
    // handler. Decode UTF-8 here so the rest of the handler can treat
    // `dataStr` uniformly.
    let dataStr: string
    if (typeof data === 'string') {
      dataStr = data
    } else if (Buffer.isBuffer(data)) {
      dataStr = data.toString('utf8')
    } else if (Array.isArray(data)) {
      // ws may also deliver concatenated Buffer chunks; concat to a
      // single Buffer first, then decode.
      dataStr = Buffer.concat(data).toString('utf8')
    } else if (data instanceof ArrayBuffer) {
      dataStr = Buffer.from(data).toString('utf8')
    } else {
      const error: WSMessageServerError = {
        type: 'error',
        error: new CustomError('Unsupported WebSocket payload type.'),
      }
      ws.send(JSON.stringify(error))
      return
    }
    try {
      const message: WSMessageClient = JSON.parse(dataStr)

      switch (message.type) {
        case 'subscribe':
          this.handleSubscribe(ws, message as WSMessageClientSubscribeSession)
          break

        case 'unsubscribe':
          this.handleUnsubscribe(ws, message as WSMessageClientUnsubscribeSession)
          break

        case 'session_list':
          this.handleSessionListRequest(ws, message as WSMessageClientSessionList)
          break

        case 'spawn':
          this.handleSpawn(ws, message as WSMessageClientSpawnSession)
          break

        case 'input':
          this.handleInput(message as WSMessageClientInput)
          break

        case 'readRaw':
          this.handleReadRaw(ws, message as WSMessageClientReadRaw)
          break

        default:
          this.handleUnknownMessage(ws, message)
      }
    } catch (err) {
      const error: WSMessageServerError = {
        type: 'error',
        error: new CustomError(inspect(err)),
      }
      ws.send(JSON.stringify(error))
    }
  }

  private handleSpawn(ws: SubscriberWebSocket, message: WSMessageClientSpawnSession) {
    // If the client asked to be subscribed, hook into the session
    // init so the WS subscribes BEFORE the replay-buffer drain emits
    // data — otherwise the first chunk(s) hit a topic with zero
    // subscribers and the client gets nothing.
    if (message.subscribe) {
      message.onSessionInit = (session) => {
        this.handleSubscribe(ws, { type: 'subscribe', sessionId: session.id })
      }
    }
    manager.spawn(message)
  }

  private handleInput(message: WSMessageClientInput) {
    manager.write(message.sessionId, message.data)
  }

  private handleReadRaw(ws: SubscriberWebSocket, message: WSMessageClientReadRaw) {
    const rawData = manager.getRawBuffer(message.sessionId)
    if (!rawData) {
      const error: WSMessageServerError = {
        type: 'error',
        error: new CustomError(`Session ${message.sessionId} not found`),
      }
      ws.send(JSON.stringify(error))
      return
    }
    const response: WSMessageServerReadRawResponse = {
      type: 'readRawResponse',
      sessionId: message.sessionId,
      rawData: rawData.raw,
    }
    ws.send(JSON.stringify(response))
  }
}

export function handleWebSocketMessage(
  ws: SubscriberWebSocket,
  data: string | Buffer | ArrayBuffer | Buffer[]
): void {
  const handler = new WebSocketHandler()
  handler.handleWebSocketMessage(ws, data)
}
