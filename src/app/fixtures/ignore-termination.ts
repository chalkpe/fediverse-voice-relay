// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

process.on('SIGTERM', () => {})
console.log(JSON.stringify({ event: 'voice-relay-listening', api: { port: 1 }, metrics: { port: 2 } }))
setInterval(() => {}, 1000)
