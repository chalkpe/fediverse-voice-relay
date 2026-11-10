// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const { TEST_KEYS } = process.env
if (!TEST_KEYS) throw new Error('Invalid test process arguments')
fs.renameSync = new Proxy(fs.renameSync, {
  apply(target, receiver, args: unknown[]) {
    if (args[1] === TEST_KEYS) throw Object.assign(new Error('forced file failure'), { code: 'EIO' })
    return Reflect.apply(target, receiver, args)
  },
})
syncBuiltinESMExports()
