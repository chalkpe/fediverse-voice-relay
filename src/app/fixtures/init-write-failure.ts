// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

let count = 0
fs.writeFileSync = new Proxy(fs.writeFileSync, {
  apply(target, receiver, args: unknown[]) {
    count++
    if (count === 3) {
      Reflect.apply(target, receiver, [args[0], 'partial'])
      throw new Error('injected failure')
    }
    return Reflect.apply(target, receiver, args)
  },
})
syncBuiltinESMExports()
