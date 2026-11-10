// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

type Prepared = { commit: () => Promise<void>; rollback: () => Promise<void> }

export class ReloadController {
  private tail: Promise<void> = Promise.resolve()
  private closing = false

  private prepare: () => Promise<Prepared>

  constructor(prepare: () => Promise<Prepared>) {
    this.prepare = prepare
  }

  reload(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Server is shutting down'))
    const operation = this.tail.then(async () => {
      if (this.closing) throw new Error('Server is shutting down')
      const prepared = await this.prepare()
      try {
        if (this.closing) throw new Error('Server is shutting down')
        await prepared.commit()
      } catch (error) {
        await prepared.rollback()
        throw error
      }
    })
    this.tail = operation.catch(() => {})
    return operation
  }

  async close(): Promise<void> {
    this.closing = true
    await this.tail
  }
}
