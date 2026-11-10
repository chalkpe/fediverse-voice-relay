// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { type AddressInfo, connect, createServer, type Socket } from 'node:net'

export async function createTestPostgresProxy(connectionString: string) {
  const upstreamUrl = new URL(connectionString)
  const sockets = new Set<Socket>()
  const server = createServer((downstream) => {
    const upstream = connect(Number(upstreamUrl.port || 5432), upstreamUrl.hostname)
    for (const socket of [downstream, upstream]) {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.on('close', () => sockets.delete(socket))
    }
    downstream.pipe(upstream)
    upstream.pipe(downstream)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = new URL(connectionString)
  url.hostname = '127.0.0.1'
  url.port = String((server.address() as AddressInfo).port)

  function disconnect() {
    for (const socket of sockets) socket.destroy()
  }

  async function close() {
    disconnect()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  return { connectionString: url.href, disconnect, close }
}
