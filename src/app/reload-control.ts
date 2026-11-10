// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { chmodSync, mkdirSync, statSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { dirname } from 'node:path'

export class ReloadFailure extends Error {}

export async function createReloadControl(path: string, reload: () => Promise<void>) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const directory = statSync(dirname(path))
  if (
    !directory.isDirectory() ||
    (directory.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && directory.uid !== process.getuid())
  ) {
    throw new Error('Reload control directory must be private and owned by the relay user')
  }
  const server = createServer((socket) => {
    socket.setTimeout(5000, () => socket.destroy())
    let data = ''
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8')
      if (data.length > 128) return socket.destroy()
      if (!data.includes('\n')) return
      socket.removeAllListeners('data')
      socket.setTimeout(0)
      if (data !== 'reload\n') return socket.end(`${JSON.stringify({ ok: false, error: 'Invalid request' })}\n`)
      void reload().then(
        () => socket.end(`${JSON.stringify({ ok: true })}\n`),
        (error) =>
          socket.end(`${JSON.stringify({ ok: false, error: error instanceof ReloadFailure ? error.message : 'Reload failed' })}\n`),
      )
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      resolve()
    })
  })
  try {
    chmodSync(path, 0o600)
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw error
  }
  return {
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}

export async function requestReload(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path)
    let data = ''
    socket.once('connect', () => socket.write('reload\n'))
    socket.on('error', reject)
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8')
      if (data.length > 4096) socket.destroy(new Error('Invalid reload response'))
    })
    let ended = false
    socket.once('close', () => {
      if (!ended) reject(new Error('Reload connection closed; outcome unknown'))
    })
    socket.once('end', () => {
      ended = true
      try {
        const reply: unknown = JSON.parse(data)
        if (!reply || typeof reply !== 'object' || !('ok' in reply)) throw new Error('Invalid reload response')
        if (reply.ok === true) resolve()
        else if ('error' in reply && typeof reply.error === 'string') reject(new Error(reply.error))
        else reject(new Error('Reload failed'))
      } catch (error) {
        reject(error)
      }
    })
  })
}
