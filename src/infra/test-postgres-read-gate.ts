// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { type AddressInfo, connect, createServer, type Socket } from 'node:net'

// 실제 SELECT 결과는 바꾸지 않고 ReadyForQuery 전달만 보류합니다.
// 앱이 첫 DB 조회를 마치기 전에 다른 연결의 커밋을 확정할 수 있습니다.
export async function createTestPostgresReadGate(connectionString: string) {
  const upstreamUrl = new URL(connectionString)
  const target = new URL(connectionString)
  const sockets = new Set<Socket>()
  let captured = false
  let resume = () => {}
  let entered!: (query: string) => void
  const ready = new Promise<string>((resolve) => {
    entered = resolve
  })
  const server = createServer((downstream) => {
    const upstream = connect(Number(upstreamUrl.port || 5432), upstreamUrl.hostname)
    for (const socket of [downstream, upstream]) {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.on('close', () => sockets.delete(socket))
    }
    let startup = true
    let frontend = Buffer.alloc(0)
    let backend = Buffer.alloc(0)
    let query = ''
    let selected = false
    let paused = false
    const held: Buffer[] = []

    downstream.on('data', (chunk: Buffer) => {
      frontend = Buffer.concat([frontend, chunk])
      if (startup) {
        if (frontend.length < 4 || frontend.length < frontend.readInt32BE(0)) return
        frontend = frontend.subarray(frontend.readInt32BE(0))
        startup = false
      }
      while (frontend.length >= 5) {
        const length = frontend.readInt32BE(1) + 1
        if (frontend.length < length) break
        const frame = frontend.subarray(0, length)
        frontend = frontend.subarray(length)
        if (frame[0] === 80) {
          const start = frame.indexOf(0, 5) + 1
          query = frame.toString('utf8', start, frame.indexOf(0, start))
        } else if (frame[0] === 81) query = frame.toString('utf8', 5, frame.length - 1)
        if (!captured && /^select\b.*\bfrom "allocations"/s.test(query)) {
          captured = true
          selected = true
        }
      }
    })
    downstream.pipe(upstream)
    upstream.on('data', (chunk: Buffer) => {
      backend = Buffer.concat([backend, chunk])
      while (backend.length >= 5) {
        const length = backend.readInt32BE(1) + 1
        if (backend.length < length) break
        const frame = backend.subarray(0, length)
        backend = backend.subarray(length)
        if (selected && frame[0] === 90) {
          selected = false
          paused = true
          resume = () => {
            paused = false
            for (const result of held.splice(0)) downstream.write(result)
          }
          entered(query)
        }
        if (paused) held.push(frame)
        else downstream.write(frame)
      }
    })
    upstream.on('end', () => downstream.end())
    downstream.on('close', () => upstream.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  target.hostname = '127.0.0.1'
  target.port = String((server.address() as AddressInfo).port)
  target.searchParams.set('sslmode', 'disable')

  async function next(): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        ready,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Snapshot SELECT did not reach ReadyForQuery')), 10000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  async function close() {
    resume()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  return { connectionString: target.href, next, release: () => resume(), close }
}
