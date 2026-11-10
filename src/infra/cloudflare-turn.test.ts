// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test, vi } from 'vitest'
import { CloudflareTurn } from './cloudflare-turn.ts'

const credentials = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'short-user', credential: 'short-secret' },
  ],
}
const ok = () => new Response(JSON.stringify(credentials), { status: 201 })
const settings = { tokenId: 'token-id', apiToken: 'long-secret' }

test('uses the fixed Cloudflare endpoint, coalesces requests, and stops reusing at half the TTL', async () => {
  vi.useFakeTimers()
  const request = vi.fn(async () => ok())
  const turn = new CloudflareTurn(() => settings, request as typeof fetch)
  try {
    const [first, second] = await Promise.all([turn.get(), turn.get()])
    expect(first).toEqual(credentials.iceServers)
    expect(second).toEqual(first)
    expect(request).toHaveBeenCalledTimes(1)
    const [url, options] = request.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/token-id/credentials/generate-ice-servers')
    expect(options.method).toBe('POST')
    expect(options.redirect).toBe('error')
    expect(options.headers).toMatchObject({ Authorization: 'Bearer long-secret' })
    expect(JSON.parse(String(options.body))).toEqual({ ttl: 86400 })
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000 - 1)
    await turn.get()
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await turn.get()
    expect(request).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})

test('rejects invalid replies without returning configured secrets and temporarily caches failures', async () => {
  vi.useFakeTimers()
  const request = vi.fn(async () => new Response(JSON.stringify({ iceServers: [{ urls: 42 }] }), { status: 201 }))
  const turn = new CloudflareTurn(() => settings, request as typeof fetch)
  try {
    await expect(turn.get()).rejects.toThrow('TURN credentials unavailable')
    await expect(turn.get()).rejects.toThrow('TURN credentials unavailable')
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60000)
    await expect(turn.get()).rejects.toThrow('TURN credentials unavailable')
    expect(request).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})

test('does not return an in-flight response after the token changes', async () => {
  let current = { ...settings }
  let release!: (response: Response) => void
  const request = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    )
    .mockImplementation(async () => ok())
  const turn = new CloudflareTurn(() => current, request as typeof fetch)
  const old = turn.get()
  const rejected = expect(old).rejects.toThrow('TURN credentials unavailable')
  current = { tokenId: 'new-id', apiToken: 'new-secret' }
  release(ok())
  await rejected
  expect(await turn.get()).toEqual(credentials.iceServers)
  expect(request).toHaveBeenCalledTimes(2)
})

test('aborts a stalled request at the timeout', async () => {
  vi.useFakeTimers()
  const request = vi.fn(
    (_url: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
  )
  const turn = new CloudflareTurn(() => settings, request as typeof fetch)
  try {
    const pending = turn.get()
    const rejected = expect(pending).rejects.toThrow('TURN credentials unavailable')
    await vi.advanceTimersByTimeAsync(5000)
    await rejected
  } finally {
    vi.useRealTimers()
  }
})

test.each([
  new Response('', { status: 302, headers: { location: 'https://other.invalid' } }),
  new Response('unauthorized long-secret', { status: 401 }),
  new Response('{', { status: 201 }),
  new Response(JSON.stringify({ iceServers: [] }), { status: 201 }),
  new Response(JSON.stringify({ iceServers: [{ urls: 'invalid-format' }] }), { status: 201 }),
  new Response('x'.repeat(65537), { status: 201 }),
])('rejects an unsuccessful or unsafe Cloudflare response', async (response) => {
  const turn = new CloudflareTurn(() => settings, vi.fn(async () => response) as typeof fetch)
  await expect(turn.get()).rejects.toThrow('TURN credentials unavailable')
})

test('sends an actual bounded HTTP request to an isolated upstream and does not follow redirects', async () => {
  const { createServer } = await import('node:http')
  let redirected = false
  let count = 0
  let received = ''
  const server = createServer((request, response) => {
    if (request.url === '/elsewhere') {
      redirected = true
      response.end()
      return
    }
    count++
    request.on('data', (chunk) => {
      received += chunk
    })
    request.on('end', () => {
      if (count === 1) {
        expect(request.headers.authorization).toBe('Bearer long-secret')
        response.writeHead(201, { 'content-type': 'application/json' })
        response.end(JSON.stringify(credentials))
      } else {
        response.writeHead(302, { location: '/elsewhere' })
        response.end()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as import('node:net').AddressInfo).port
  const request: typeof fetch = async (url, options) => {
    expect(String(url)).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/token-id/credentials/generate-ice-servers')
    return fetch(`http://127.0.0.1:${port}/generate`, options)
  }
  try {
    const first = new CloudflareTurn(() => settings, request)
    expect(await first.get()).toEqual(credentials.iceServers)
    expect(JSON.parse(received)).toEqual({ ttl: 86400 })
    received = ''
    const second = new CloudflareTurn(() => settings, request)
    await expect(second.get()).rejects.toThrow('TURN credentials unavailable')
    expect(redirected).toBe(false)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('an older request cannot replace or clear a newer in-flight request', async () => {
  let current = { ...settings }
  const releases: Array<(response: Response) => void> = []
  const request = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        releases.push(resolve)
      }),
  )
  const turn = new CloudflareTurn(() => current, request as typeof fetch)
  const first = turn.get()
  const firstRejected = expect(first).rejects.toThrow('TURN credentials unavailable')
  current = { tokenId: 'new-id', apiToken: 'new-secret' }
  const second = turn.get()
  releases[0](ok())
  await firstRejected
  const third = turn.get()
  expect(request).toHaveBeenCalledTimes(2)
  releases[1](ok())
  expect(await second).toEqual(credentials.iceServers)
  expect(await third).toEqual(credentials.iceServers)
  expect(await turn.get()).toEqual(credentials.iceServers)
  expect(request).toHaveBeenCalledTimes(2)
})

test('returns all documented response URLs without filtering', async () => {
  const response = { iceServers: [{ urls: ['turn:127.0.0.1:53', 'stun:stun.cloudflare.com:3478'] }] }
  const turn = new CloudflareTurn(
    () => settings,
    vi.fn(async () => new Response(JSON.stringify(response), { status: 201 })) as typeof fetch,
  )
  expect(await turn.get()).toEqual(response.iceServers)
})
