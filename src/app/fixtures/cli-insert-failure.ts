// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import pg from 'pg'

pg.Client.prototype.query = new Proxy(pg.Client.prototype.query, {
  apply(target, receiver, args: unknown[]) {
    const first = args[0]
    const text = typeof first === 'string' ? first : first && typeof first === 'object' && 'text' in first ? first.text : undefined
    if (typeof text === 'string' && text.toLowerCase().startsWith('insert into "clients"')) {
      return Promise.reject(new Error('injected client insert failure'))
    }
    return Reflect.apply(target, receiver, args)
  },
})
