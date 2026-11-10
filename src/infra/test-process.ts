// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { fork } from 'node:child_process'

type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: Error }

export function startTestProcess<Message>(file: URL, options: { args?: string[]; env?: NodeJS.ProcessEnv; execArgv?: string[] } = {}) {
  const child = fork(file, options.args ?? [], {
    env: options.env ?? process.env,
    execArgv: options.execArgv ?? [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  const messages: Message[] = []
  const waiters: Array<(message: Message) => void> = []
  let result: Exit | undefined
  const exited = new Promise<Exit>((resolve) => {
    child.once('exit', (code, signal) => {
      result = { code, signal }
      resolve(result)
    })
    child.once('error', (error) => {
      result = { code: null, signal: null, error }
      resolve(result)
    })
  })
  child.on('message', (message) => {
    const waiter = waiters.shift()
    if (waiter) waiter(message as Message)
    else messages.push(message as Message)
  })

  async function next(): Promise<Message> {
    const message = messages.shift()
    if (message !== undefined) return message
    if (result) throw new Error('Test child exited before its next message')
    let waiter: (message: Message) => void = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        new Promise<Message>((resolve) => {
          waiter = resolve
          waiters.push(waiter)
        }),
        exited.then(() => {
          throw new Error('Test child exited before its next message')
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Test child message timed out')), 5000)
        }),
      ])
    } finally {
      clearTimeout(timer)
      const index = waiters.indexOf(waiter)
      if (index >= 0) waiters.splice(index, 1)
    }
  }

  async function close() {
    if (!result) child.kill('SIGKILL')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Test child cleanup timed out')), 5000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  async function waitForExit() {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Test child exit timed out')), 5000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  function send(message: object) {
    if (!child.connected) throw new Error('Test child IPC is closed')
    child.send(message)
  }

  return { next, waitForExit, close, send }
}
