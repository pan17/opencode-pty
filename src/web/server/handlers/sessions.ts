import { manager } from '../../../plugin/pty/manager.ts'
import type { NodeBunRequest } from '../server.ts'
import { JsonResponse, ErrorResponse } from './responses.ts'

// ANSI escape sequence regex. Matches CSI sequences (`ESC[` ... letter) and
// the standalone ESC + single-char sequences used by some terminals.
// Equivalent to Bun.stripANSI for our purposes (color/format stripping).
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is required to match ANSI sequences
const ANSI_ESCAPE_RE = /\u001b\[[0-9;?]*[a-zA-Z]|\u001b[^[\u001b]?]/g

function stripANSI(s: string): string {
  return s.replace(ANSI_ESCAPE_RE, '')
}

export function getSessions() {
  const sessions = manager.list()
  return new JsonResponse(sessions)
}

export async function createSession(req: NodeBunRequest) {
  let body: {
    command: string
    args?: string[]
    description?: string
    workdir?: string
    timeoutSeconds?: number
  }

  try {
    body = (await req.json()) as typeof body
  } catch {
    return new ErrorResponse('Invalid JSON in request body', 400)
  }

  if (!body.command || typeof body.command !== 'string' || body.command.trim() === '') {
    return new ErrorResponse('Command is required', 400)
  }

  try {
    const session = manager.spawn({
      command: body.command,
      args: body.args || [],
      title: body.description,
      description: body.description,
      workdir: body.workdir,
      timeoutSeconds: body.timeoutSeconds,
      parentSessionId: 'web-api',
    })
    return new JsonResponse(session)
  } catch (error) {
    return new ErrorResponse(
      error instanceof Error ? error.message : 'Failed to create session',
      400
    )
  }
}

export function clearSessions() {
  manager.clearAllSessions()
  return new JsonResponse({ success: true })
}

export function getSession(req: NodeBunRequest<{ id: string }>) {
  const session = manager.get(req.params.id)
  if (!session) {
    return new ErrorResponse('Session not found', 404)
  }
  return new JsonResponse(session)
}

export async function sendInput(req: NodeBunRequest<{ id: string }>): Promise<Response> {
  try {
    const body = (await req.json()) as { data: string }
    if (!body.data || typeof body.data !== 'string') {
      return new ErrorResponse('Data field is required and must be a string', 400)
    }
    const success = manager.write(req.params.id, body.data)
    if (!success) {
      return new ErrorResponse('Failed to write to session', 400)
    }
    return new JsonResponse({ success: true })
  } catch {
    return new ErrorResponse('Invalid JSON in request body', 400)
  }
}

export function cleanupSession(req: NodeBunRequest<{ id: string }>) {
  const success = manager.kill(req.params.id, true)
  if (!success) {
    return new ErrorResponse('Failed to kill session', 400)
  }
  return new JsonResponse({ success: true })
}

export function killSession(req: NodeBunRequest<{ id: string }>) {
  const success = manager.kill(req.params.id)
  if (!success) {
    return new ErrorResponse('Failed to kill session', 400)
  }
  return new JsonResponse({ success: true })
}

export function getRawBuffer(req: NodeBunRequest<{ id: string }>) {
  const bufferData = manager.getRawBuffer(req.params.id)
  if (!bufferData) {
    return new ErrorResponse('Session not found', 404)
  }

  return new JsonResponse(bufferData)
}

export function getPlainBuffer(req: NodeBunRequest<{ id: string }>) {
  const bufferData = manager.getRawBuffer(req.params.id)
  if (!bufferData) {
    return new ErrorResponse('Session not found', 404)
  }

  const plainText = stripANSI(bufferData.raw)
  return new JsonResponse({
    plain: plainText,
    byteLength: new TextEncoder().encode(plainText).length,
  })
}
