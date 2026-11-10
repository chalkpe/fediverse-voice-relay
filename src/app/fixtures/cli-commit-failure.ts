// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import pg from 'pg'

const mode = process.env.TEST_COMMIT
if (mode !== 'rollback' && mode !== 'committed') throw new Error('Invalid test process arguments')
let inserted = false
pg.Client.prototype.query = new Proxy(pg.Client.prototype.query, {
  apply(target, receiver, args: unknown[]) {
    const first = args[0]
    const text = typeof first === 'string' ? first : first && typeof first === 'object' && 'text' in first ? first.text : undefined
    if (typeof text === 'string' && text.toLowerCase().startsWith('insert into "clients"')) inserted = true
    if (text === 'COMMIT' && inserted) {
      return Promise.resolve(Reflect.apply(target, receiver, [mode === 'rollback' ? 'ROLLBACK' : 'COMMIT'])).then(() => {
        throw new Error('lost commit result')
      })
    }
    return Reflect.apply(target, receiver, args)
  },
})
