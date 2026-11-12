// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

// 실제 LiveKit 조회 응답을 전달하기 전에 세션 교체를 끝내도록 동기화합니다.
export async function createLiveKitGate(upstream: string, afterGetParticipant: () => Promise<void>) {
  let pending = true
  let failure: unknown
  const methods: string[] = []

  async function forward(request: IncomingMessage, response: ServerResponse) {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const method = request.url?.split('/').at(-1) ?? ''
    methods.push(method)
    const result = await fetch(new URL(request.url ?? '/', upstream), {
      method: request.method,
      headers: { authorization: request.headers.authorization ?? '', 'content-type': 'application/json' },
      body: Buffer.concat(chunks),
      signal: AbortSignal.timeout(10000),
    })
    const body = new Uint8Array(await result.arrayBuffer())
    if (pending && method === 'GetParticipant' && result.ok) {
      pending = false
      await afterGetParticipant()
    }
    response.writeHead(result.status, { 'content-type': result.headers.get('content-type') ?? 'application/json' })
    response.end(body)
  }

  const server = createServer((request, response) => {
    void forward(request, response).catch((error) => {
      failure = error
      response.writeHead(502).end()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    methods,
    verify: () => {
      if (failure) throw failure
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}
