// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const { TEST_KEYS, TEST_FIFO } = process.env
if (!TEST_KEYS || !TEST_FIFO) throw new Error('Invalid test process arguments')
fs.readFileSync = new Proxy(fs.readFileSync, {
  apply(target, receiver, args: unknown[]) {
    const result = Reflect.apply(target, receiver, args)
    if (args[0] === TEST_KEYS && process.env.TEST_GATE) {
      delete process.env.TEST_GATE
      process.send?.({ type: 'read' })
      Reflect.apply(target, receiver, [TEST_FIFO])
    }
    return result
  },
})
fs.mkdirSync = new Proxy(fs.mkdirSync, {
  apply(target, receiver, args: unknown[]) {
    if (args[0] === `${TEST_KEYS}.lock`) process.send?.({ type: 'lock' })
    return Reflect.apply(target, receiver, args)
  },
})
syncBuiltinESMExports()
