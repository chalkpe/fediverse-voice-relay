// SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { type ParseArgsOptionsConfig, parseArgs } from 'node:util'

type OptionDefinition = {
  type: 'string' | 'boolean'
  description: string
  valueName?: string
  required?: boolean
  short?: string
}

type CommandDefinition = {
  description: string
  options?: Record<string, OptionDefinition>
  children?: Record<string, CommandDefinition>
}

const helpOption: OptionDefinition = { type: 'boolean', short: 'h', description: '도움말을 표시합니다.' }
const originOption: OptionDefinition = { type: 'string', valueName: 'HTTPS_ORIGIN', required: true, description: '이용 서버의 HTTPS 주소' }
const commands: CommandDefinition = {
  description: '릴레이 설정과 클라이언트 계약을 관리합니다.',
  children: {
    reload: {
      description: '설정을 다시 읽습니다. DB와 LiveKit 접속 정보 변경에는 재시작이 필요합니다.',
      options: {},
    },
    init: {
      description: '릴레이 설정을 생성합니다.',
      options: {
        'public-url': { type: 'string', valueName: 'HTTPS_ORIGIN', required: true, description: '운영할 릴레이의 공개 HTTPS 주소' },
      },
    },
    client: {
      description: '클라이언트 계약을 관리합니다.',
      children: {
        add: {
          description: '활성 클라이언트를 추가합니다.',
          options: {
            origin: originOption,
            'max-slots': { type: 'string', valueName: 'N', required: true, description: '최대 슬롯 수' },
            'max-rooms': { type: 'string', valueName: 'N', required: true, description: '최대 방 수' },
            'allow-screen-share': { type: 'boolean', description: '화면 공유를 허용합니다. 생략하면 금지됩니다.' },
          },
        },
        list: { description: '클라이언트 목록을 표시합니다.', options: {} },
        enable: { description: '클라이언트를 활성화합니다.', options: { origin: originOption } },
        'rotate-secret': { description: '이용 서버의 시크릿을 교체합니다.', options: { origin: originOption } },
        disable: { description: '클라이언트를 비활성화합니다.', options: { origin: originOption } },
      },
    },
  },
}

function optionsFor(command: CommandDefinition): Record<string, OptionDefinition> {
  return { ...command.options, help: helpOption }
}

function helpText(command: CommandDefinition, path: string[]): string {
  const options = optionsFor(command)
  const suffix = command.children ? ' <COMMAND> [--help]' : ' [OPTIONS]'
  const lines = [`Usage: node src/app/cli.ts${path.length ? ` ${path.join(' ')}` : ''}${suffix}`, '', command.description]
  if (command.children) {
    lines.push('', 'Commands:')
    for (const [name, child] of Object.entries(command.children)) lines.push(`  ${name}  ${child.description}`)
  }
  lines.push('', 'Options:')
  for (const [name, option] of Object.entries(options)) {
    const label = `${option.short ? `-${option.short}, ` : ''}--${name}${option.valueName ? ` ${option.valueName}` : ''}`
    lines.push(`  ${label}  ${option.description} ${option.required ? '(필수)' : '(선택)'}`)
  }
  return lines.join('\n')
}

const input = process.argv.slice(2)
let command = commands
const path: string[] = []
while (command.children && input.length > path.length) {
  const next = input[path.length]
  if (next === '--help' || next === '-h') break
  const child: CommandDefinition | undefined = Object.hasOwn(command.children, next) ? command.children[next] : undefined
  if (!child) break
  command = child
  path.push(next)
}

let origin: URL | undefined
let slots = 0
let rooms = 0
let screenShare = false
const action = path[0] === 'client' ? path[1] : undefined
try {
  const args = input.slice(path.length)
  if (command.children && !(args.length === 1 && (args[0] === '--help' || args[0] === '-h'))) {
    throw new Error('Invalid command.')
  }
  const definitions = optionsFor(command)
  const options: ParseArgsOptionsConfig = Object.fromEntries(
    Object.entries(definitions).map(([name, option]) => [name, { type: option.type, ...(option.short ? { short: option.short } : {}) }]),
  )
  const parsed = parseArgs({ args, options, strict: true, allowPositionals: false, tokens: true })
  const seen = new Set<string>()
  for (const token of parsed.tokens) {
    if (token.kind === 'option') {
      if (seen.has(token.name)) throw new Error(`Duplicate option: --${token.name}`)
      seen.add(token.name)
    }
  }
  if (parsed.values.help) {
    console.log(helpText(command, path))
    process.exit(0)
  }
  const required = Object.entries(definitions)
    .filter(([, option]) => option.required)
    .map(([name]) => name)
  if (required.some((name) => parsed.values[name] === undefined)) {
    const names = required.map((name) => `--${name}`)
    const label = names.length > 1 ? `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}` : names[0]
    throw new Error(`${path.at(-1)} requires ${label}`)
  }
  if (path[0] === 'reload') {
    const { requestReload } = await import('./reload-control.ts')
    await requestReload(process.env.VOICE_RELAY_CONTROL ?? '/tmp/voice-relay/relay.sock')
    console.log('Configuration reloaded.')
    process.exit(0)
  }
  if (path[0] === 'init') {
    if (typeof parsed.values['public-url'] !== 'string' || !parsed.values['public-url']) throw new Error('init requires --public-url')
    const { init } = await import('./init.ts')
    init(parsed.values['public-url'])
    console.log('Configuration created in .env and secrets/.')
    process.exit(0)
  }
  if (action === 'add' || action === 'enable' || action === 'disable' || action === 'rotate-secret') {
    const rawOrigin = parsed.values.origin
    if (typeof rawOrigin !== 'string') throw new Error(`${action} requires --origin`)
    const { publicHttpsOriginSchema } = await import('../relay/schema.ts')
    const parsedOrigin = publicHttpsOriginSchema.safeParse(rawOrigin)
    if (!parsedOrigin.success) throw new Error('Canonical HTTPS origin required')
    origin = parsedOrigin.data
  }
  if (action === 'add') {
    const rawSlots = parsed.values['max-slots']
    const rawRooms = parsed.values['max-rooms']
    if (typeof rawSlots !== 'string' || typeof rawRooms !== 'string') throw new Error('add requires --origin, --max-slots, and --max-rooms')
    slots = Number(rawSlots)
    rooms = Number(rawRooms)
    if (
      !/^\d+$/.test(rawSlots) ||
      !Number.isSafeInteger(slots) ||
      slots < 1 ||
      !/^\d+$/.test(rawRooms) ||
      !Number.isSafeInteger(rooms) ||
      rooms < 1
    ) {
      throw new Error('Canonical HTTPS origin and positive limits required')
    }
    screenShare = parsed.values['allow-screen-share'] === true
  }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}\n${helpText(command, path)}`)
  process.exit(1)
}
const { Pool } = await import('pg')
const { eq } = await import('drizzle-orm')
const { drizzle } = await import('drizzle-orm/node-postgres')
const { clients } = await import('../infra/schema.ts')
const { Store } = await import('../infra/store.ts')
const { loadConfig, loadSecrets } = await import('./config.ts')
const config = loadConfig(process.env.VOICE_RELAY_CONFIG ?? 'config.json')
const store = new Store(new Pool({ connectionString: config.databaseUrl }))
await store.migrate()
function atomicWrite(file: string, value: unknown) {
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(tmp, file)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // 원래 오류를 보존하며 임시 파일이 남을 수 있습니다.
    }
    throw error
  }
}

function readKeys() {
  try {
    return loadSecrets(config.clientSecretFile)
  } catch {
    if (readFileSync(config.clientSecretFile, 'utf8').trim() !== '') throw new Error('Invalid secret file')
    return {}
  }
}
const journalFile = `${config.clientSecretFile}.pending`
type Pending = { id: string; secret: string }

async function recoverKeys() {
  let pending: Pending
  try {
    pending = JSON.parse(readFileSync(journalFile, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error('Invalid pending secret recovery file')
  }
  if (!pending || typeof pending.id !== 'string' || typeof pending.secret !== 'string' || pending.secret.length < 32)
    throw new Error('Invalid pending secret recovery file')
  const secrets = readKeys()
  const current = Object.hasOwn(secrets, pending.id) ? secrets[pending.id] : undefined
  if (current && current !== pending.secret) throw new Error('Pending secret conflicts with secret file')
  const result = await store.db.select({ id: clients.id }).from(clients).where(eq(clients.id, pending.id))
  if (result.length && !current) {
    secrets[pending.id] = pending.secret
    atomicWrite(config.clientSecretFile, secrets)
  } else if (!result.length && current) {
    delete secrets[pending.id]
    atomicWrite(config.clientSecretFile, secrets)
  }
  unlinkSync(journalFile)
}

async function findClient(origin: URL | undefined) {
  if (!origin) throw new Error('HTTPS origin required')
  const [client] = await store.db.select().from(clients).where(eq(clients.origin, origin.origin))
  if (!client) throw new Error('Client origin not registered')
  return client
}

async function withKeyLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = `${config.clientSecretFile}.lock`
  const acquire = () => {
    try {
      mkdirSync(lock, { mode: 0o700 })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      return false
    }
  }
  const deadline = Date.now() + 10000
  let locked = acquire()
  while (!locked) {
    locked = await new Promise<boolean>((resolve, reject) => {
      const watcher = watch(dirname(lock), () => finish())
      const timer = setTimeout(
        () => finish(false, new Error('Secret lock busy; check for an interrupted CLI command')),
        Math.max(0, deadline - Date.now()),
      )
      const finish = (acquired = false, error?: Error) => {
        clearTimeout(timer)
        watcher.close()
        if (error) reject(error)
        else resolve(acquired)
      }
      watcher.once('error', (error) => finish(false, error))
      // 잠금 해제를 놓치지 않도록 구독한 뒤 다시 확인합니다.
      try {
        if (acquire()) finish(true)
      } catch (error) {
        finish(false, error as Error)
      }
    })
  }

  try {
    return await store.serialized('cli-client-keys', fn)
  } finally {
    rmdirSync(lock)
  }
}

try {
  if (action === 'list') {
    const result = await store.db
      .select({
        origin: clients.origin,
        enabled: clients.enabled,
        max_slots: clients.maxSlots,
        max_rooms: clients.maxRooms,
        allow_screen_share: clients.allowScreenShare,
      })
      .from(clients)
      .orderBy(clients.origin)
    console.log(JSON.stringify(result, null, 2))
  }
  if (action === 'add') {
    if (!origin) throw new Error('Canonical HTTPS origin and positive limits required')
    const id = randomUUID()
    const secret = randomBytes(32).toString('hex')
    await withKeyLock(async () => {
      await recoverKeys()
      const secrets = readKeys()
      if (Object.hasOwn(secrets, id)) throw new Error('Generated client ID already exists in secret file')
      atomicWrite(journalFile, { id, secret })
      try {
        await store.tx(async (db) => {
          await drizzle(db)
            .insert(clients)
            .values({ id, origin: origin.origin, maxSlots: slots, maxRooms: rooms, allowScreenShare: screenShare, enabled: true })
          atomicWrite(config.clientSecretFile, { ...secrets, [id]: secret })
        })
      } catch (error) {
        await recoverKeys().catch(() => {})
        const cause =
          (error as { cause?: { code?: string; constraint?: string } }).cause ?? (error as { code?: string; constraint?: string })
        if (cause.code === '23505' && cause.constraint === 'clients_origin_unique') throw new Error('Client origin already registered')
        throw error
      }
      unlinkSync(journalFile)
    })
    console.log(JSON.stringify({ origin: origin.origin, secret }, null, 2))
  }
  if (action === 'enable') {
    const c = await findClient(origin)
    await store.db.update(clients).set({ enabled: true }).where(eq(clients.id, c.id))
    console.log('Client enabled')
  }
  if (action === 'rotate-secret') {
    const result = await withKeyLock(async () => {
      await recoverKeys()
      const c = await findClient(origin)
      const secrets = readKeys()
      const secret = randomBytes(32).toString('hex')
      secrets[c.id] = secret
      atomicWrite(config.clientSecretFile, secrets)
      return { origin: c.origin, secret }
    })
    console.log(JSON.stringify(result, null, 2))
  }
  if (action === 'disable') {
    const c = await findClient(origin)
    await store.db.update(clients).set({ enabled: false }).where(eq(clients.id, c.id))
    console.log('Client disabled; the running server retries termination until all hosted rooms are confirmed ended.')
  }
} finally {
  await store.pool.end()
}
