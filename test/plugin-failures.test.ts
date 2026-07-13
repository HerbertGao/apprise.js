// SPDX-License-Identifier: BSD-2-Clause
// Plugin failure / error-path tests.
//
// The golden fixtures only drive the HAPPY path (a 200 with a well-formed body),
// so every plugin's response predicate and its attachment / target guards are
// otherwise unverified. Each expectation below is derived from the plugin's
// upstream Python @ v1.12.0, NOT from what the TS currently returns:
//
//   discord.py:855-858      200 (ok) or 204 (no_content) succeed; anything else fails.
//   discord.py:781-786      an inaccessible attachment aborts the post (return False).
//   apprise_api.py:406      `!= requests.codes.ok` fails -> success is EXACTLY 200.
//   mattermost.py:373       `!= requests.codes.ok` fails; has_error is per-channel.
//   slack.py:1553-1575      BOT: json `ok` truthy (or b"OK" in the body); WEBHOOK:
//                           the body must be exactly b"ok"; both also need HTTP 200.
//   slack.py:1130-1136      a webhook + attachment only WARNS; the message still goes.
//   slack.py (send)         a target failing the channel regex is skipped + has_error.
//   telegram.py:633/700     `!= requests.codes.ok` fails.
//   rocketchat.py:568/624/  every POST requires 200; login additionally requires a
//              646-648      JSON body whose `status` == "success".
//   matrix base.py (_fetch) every call requires 200; _login without an access_token
//                           in the response fails.
//
// Wire requests are captured through the injectable transport seam (as the
// golden harness does); the plugins are built from their own parseUrl, with `/#`
// pre-encoded as `/%23` exactly as Apprise.instantiate does (upstream
// url_to_dict).

import { afterEach, describe, expect, test } from 'vitest'
import { AttachFile } from '../src/attachment/file.js'
import { AttachMemory } from '../src/attachment/memory.js'
import {
  setTransport,
  type TransportRequest,
  type TransportResponse,
} from '../src/core/transport.js'
import {
  NotifyAppriseAPI,
  type NotifyAppriseAPIArgs,
} from '../src/plugins/apprise-api.js'
import {
  NotifyDiscord,
  type NotifyDiscordArgs,
} from '../src/plugins/discord.js'
import { NotifyMatrix, type NotifyMatrixArgs } from '../src/plugins/matrix.js'
import {
  NotifyMattermost,
  type NotifyMattermostArgs,
} from '../src/plugins/mattermost.js'
import {
  NotifyRocketChat,
  type NotifyRocketChatArgs,
} from '../src/plugins/rocketchat.js'
import { NotifySlack, type NotifySlackArgs } from '../src/plugins/slack.js'
import {
  NotifyTelegram,
  type NotifyTelegramArgs,
} from '../src/plugins/telegram.js'

// --- transport stub ----------------------------------------------------------

interface Reply {
  status: number
  body?: string
}

/**
 * Replay `replies` in order (the last one repeats once exhausted) and record
 * every request the plugin emits. Returns the live request log.
 */
function stub(...replies: Reply[]): TransportRequest[] {
  const seen: TransportRequest[] = []
  setTransport(async (req): Promise<TransportResponse> => {
    const reply = replies[Math.min(seen.length, replies.length - 1)] ?? {
      status: 200,
    }
    seen.push(req)
    const body = reply.body ?? '{}'
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      statusText: '',
      headers: new Headers(),
      text: async () => body,
    }
  })
  return seen
}

afterEach(() => {
  setTransport(null)
})

/** An attachment whose backing file does not exist (`exists()` -> false). */
const missingAttachment = () =>
  new AttachFile('/nonexistent/apprise-js/definitely-missing.bin')

// --- discord -----------------------------------------------------------------

describe('discord failure paths', () => {
  const build = () =>
    new NotifyDiscord(
      NotifyDiscord.parseUrl(
        'discord://10101010/abcdefghijklmnop',
      ) as unknown as NotifyDiscordArgs,
    )

  test('a 500 response fails the notification', async () => {
    const seen = stub({ status: 500 })
    expect(await build().notify({ body: 'b' })).toBe(false)
    expect(seen).toHaveLength(1)
  })

  test('a 204 (no content) response SUCCEEDS (discord.py accepts it)', async () => {
    const seen = stub({ status: 204, body: '' })
    expect(await build().notify({ body: 'b' })).toBe(true)
    expect(seen).toHaveLength(1)
  })

  test('a 201 response fails (only 200/204 are accepted)', async () => {
    stub({ status: 201 })
    expect(await build().notify({ body: 'b' })).toBe(false)
  })

  test('an inaccessible attachment aborts after the text post', async () => {
    const seen = stub({ status: 200 })
    expect(
      await build().notify({ body: 'b', attach: missingAttachment() }),
    ).toBe(false)
    // The text content posts first (200); the attachment batch never reaches the
    // wire because `not attachment` short-circuits the multipart build.
    expect(seen).toHaveLength(1)
  })
})

// --- apprise-api -------------------------------------------------------------

describe('apprise-api failure paths', () => {
  const build = (url: string) =>
    new NotifyAppriseAPI(
      NotifyAppriseAPI.parseUrl(url) as unknown as NotifyAppriseAPIArgs,
    )

  test('success is EXACTLY 200 — a 201 fails (unlike custom-json, which takes any 2xx)', async () => {
    stub({ status: 201 })
    expect(
      await build('apprise://localhost/abc123').notify({ body: 'b' }),
    ).toBe(false)
  })

  test('a 200 succeeds', async () => {
    stub({ status: 200 })
    expect(
      await build('apprise://localhost/abc123').notify({ body: 'b' }),
    ).toBe(true)
  })

  test('an inaccessible attachment (method=json) fails before any request', async () => {
    const seen = stub({ status: 200 })
    expect(
      await build('apprise://localhost/abc123?method=json').notify({
        body: 'b',
        attach: missingAttachment(),
      }),
    ).toBe(false)
    expect(seen).toHaveLength(0)
  })

  // No `?method=` here on purpose: this pins that the DEFAULT method is `form`
  // (upstream apprise_api.py METHODS[0]), which is what refuses the attachment.
  test('an attachment with the default method (form) is refused (multipart deferred) — no request', async () => {
    const seen = stub({ status: 200 })
    expect(
      await build('apprise://localhost/abc123').notify({
        body: 'b',
        attach: new AttachMemory({ content: 'c', name: 'a.txt' }),
      }),
    ).toBe(false)
    expect(seen).toHaveLength(0)
  })

  test('an invalid token / method is rejected at construction', () => {
    expect(() => build('apprise://localhost/bad.token')).toThrow(/token/i)
    expect(() => build('apprise://localhost/abc123?method=bogus')).toThrow(
      /method/i,
    )
  })
})

// --- mattermost ---------------------------------------------------------------

describe('mattermost failure paths', () => {
  const build = (url: string) =>
    new NotifyMattermost(
      NotifyMattermost.parseUrl(url) as unknown as NotifyMattermostArgs,
    )

  test('a non-200 response fails the notification', async () => {
    const seen = stub({ status: 500 })
    expect(await build('mmost://host/token1').notify({ body: 'b' })).toBe(false)
    expect(seen).toHaveLength(1)
  })

  test('one failing channel out of two fails the whole target, both still posted', async () => {
    // parse_list sorts: alpha then bravo.
    const seen = stub({ status: 200 }, { status: 500 })
    expect(
      await build('mmost://host/token1?channel=bravo,alpha').notify({
        body: 'b',
      }),
    ).toBe(false)
    expect(seen).toHaveLength(2)
    expect(JSON.parse(String(seen[0]?.body)).channel).toBe('alpha')
    expect(JSON.parse(String(seen[1]?.body)).channel).toBe('bravo')
  })

  test('bot mode is refused at construction (deferred this batch)', () => {
    expect(() => build('mmost://host/token1?mode=bot')).toThrow(/bot mode/i)
  })
})

// --- slack --------------------------------------------------------------------

describe('slack failure paths', () => {
  const WEBHOOK = 'slack://T1JJ3T3L2/A1BRTD4JD/TIiajkdnlazkcOXrIdevi7/'
  const BOT = 'slack://xoxb-1234-1234-4ddbc191d40ee098cbaae6f3523ada2d/%23test'
  const build = (url: string) =>
    new NotifySlack(NotifySlack.parseUrl(url) as unknown as NotifySlackArgs)

  test('webhook: a 200 whose body is exactly "ok" succeeds', async () => {
    stub({ status: 200, body: 'ok' })
    expect(await build(WEBHOOK).notify({ body: 'b' })).toBe(true)
  })

  test('webhook: a 200 whose body is NOT "ok" fails (upstream r.content == b"ok")', async () => {
    stub({ status: 200, body: 'invalid_payload' })
    expect(await build(WEBHOOK).notify({ body: 'b' })).toBe(false)
  })

  test('webhook: a 500 fails even with an "ok" body', async () => {
    stub({ status: 500, body: 'ok' })
    expect(await build(WEBHOOK).notify({ body: 'b' })).toBe(false)
  })

  test('bot: a 200 carrying {"ok": false} fails', async () => {
    stub({ status: 200, body: '{"ok": false, "error": "not_in_channel"}' })
    expect(await build(BOT).notify({ body: 'b' })).toBe(false)
  })

  test('bot: a 200 carrying {"ok": true} succeeds', async () => {
    stub({ status: 200, body: '{"ok": true, "channel": "C123"}' })
    expect(await build(BOT).notify({ body: 'b' })).toBe(true)
  })

  test('a target that fails the channel regex is skipped and fails the notify', async () => {
    const seen = stub({ status: 200, body: 'ok' })
    // "a!b" is not [+#@]?[A-Z0-9_-]{1,32} -> upstream warns, skips, has_error.
    expect(await build(`${WEBHOOK}?to=a!b`).notify({ body: 'b' })).toBe(false)
    expect(seen).toHaveLength(0)
  })

  test('a webhook + attachment only warns — the message is still delivered', async () => {
    const seen = stub({ status: 200, body: 'ok' })
    expect(
      await build(WEBHOOK).notify({
        body: 'b',
        attach: new AttachMemory({ content: 'c', name: 'a.txt' }),
      }),
    ).toBe(true)
    // slack.py:1130-1136 logs a warning and carries on; no upload request.
    expect(seen).toHaveLength(1)
  })

  test('bot: an inaccessible attachment fails the upload flow', async () => {
    const seen = stub({ status: 200, body: '{"ok": true, "channel": "C123"}' })
    expect(
      await build(BOT).notify({ body: 'b', attach: missingAttachment() }),
    ).toBe(false)
    // Only chat.postMessage went out; files.getUploadURLExternal is never reached.
    expect(seen).toHaveLength(1)
  })
})

// --- telegram -----------------------------------------------------------------

describe('telegram failure paths', () => {
  const build = () =>
    new NotifyTelegram(
      NotifyTelegram.parseUrl(
        'tgram://123456789:ABCdef_ghi-jkl/12345',
      ) as unknown as NotifyTelegramArgs,
    )

  test('a non-200 sendMessage response fails the notification', async () => {
    const seen = stub({ status: 400, body: '{"ok": false}' })
    expect(await build().notify({ body: 'b' })).toBe(false)
    expect(seen).toHaveLength(1)
  })

  test('a 200 succeeds', async () => {
    stub({ status: 200 })
    expect(await build().notify({ body: 'b' })).toBe(true)
  })

  test('an inaccessible attachment fails before any request', async () => {
    const seen = stub({ status: 200 })
    expect(
      await build().notify({ body: 'b', attach: missingAttachment() }),
    ).toBe(false)
    // The body rides as the attachment caption, so sendMessage is never issued
    // and sendMedia bails on `not attachment`.
    expect(seen).toHaveLength(0)
  })
})

// --- rocketchat ---------------------------------------------------------------

describe('rocketchat failure paths', () => {
  const build = (url: string) =>
    new NotifyRocketChat(
      NotifyRocketChat.parseUrl(url) as unknown as NotifyRocketChatArgs,
    )
  const BASIC = 'rocket://user:pass@localhost/%23general'
  const TOKEN =
    'rocket://user:abcdefghijklmnopqrstuvwxyz0123456789@localhost/%23channel'
  const WEBHOOK = 'rocket://tokenaaa/tokenbbb@localhost'
  const LOGIN_OK =
    '{"status": "success", "data": {"authToken": "t", "userId": "u"}}'

  test('basic: a failed login aborts (no postMessage, no logout)', async () => {
    const seen = stub({ status: 500 })
    expect(await build(BASIC).notify({ body: 'b' })).toBe(false)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('http://localhost/api/v1/login')
  })

  test('basic: a 200 login whose status is not "success" aborts', async () => {
    const seen = stub({ status: 200, body: '{"status": "error"}' })
    expect(await build(BASIC).notify({ body: 'b' })).toBe(false)
    expect(seen).toHaveLength(1)
  })

  test('basic: a failing postMessage fails the notify but still logs out', async () => {
    const seen = stub(
      { status: 200, body: LOGIN_OK },
      { status: 500 },
      { status: 200 },
    )
    expect(await build(BASIC).notify({ body: 'b' })).toBe(false)
    expect(seen.map((r) => r.url)).toEqual([
      'http://localhost/api/v1/login',
      'http://localhost/api/v1/chat.postMessage',
      'http://localhost/api/v1/logout',
    ])
  })

  test('token: a failing postMessage fails — no login/logout requests at all', async () => {
    const seen = stub({ status: 401 })
    expect(await build(TOKEN).notify({ body: 'b' })).toBe(false)
    expect(seen.map((r) => r.url)).toEqual([
      'http://localhost/api/v1/chat.postMessage',
    ])
  })

  test('webhook: a non-200 fails', async () => {
    const seen = stub({ status: 500 })
    expect(await build(WEBHOOK).notify({ body: 'b' })).toBe(false)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('http://localhost/hooks/tokenaaa/tokenbbb')
  })

  test('basic mode with no room/channel target is rejected at construction', () => {
    expect(() => build('rocket://user:pass@localhost')).toThrow(
      /room and\/or channels/i,
    )
  })

  test('an invalid auth mode is rejected at construction', () => {
    expect(() => build(`${BASIC}?mode=bogus`)).toThrow(
      /authentication mode specified/i,
    )
  })
})

// --- matrix -------------------------------------------------------------------

describe('matrix failure paths', () => {
  const build = (url: string) =>
    new NotifyMatrix(NotifyMatrix.parseUrl(url) as unknown as NotifyMatrixArgs)
  const T2BOT =
    'matrix://abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
  const DIRECT =
    'matrixs://user:pass@matrix.example.com/!abc:matrix.example.com?discovery=no&e2ee=no'
  const LOGIN_OK =
    '{"access_token": "t", "user_id": "@u:matrix.example.com", "home_server": "matrix.example.com"}'

  test('t2bot: a non-200 fails', async () => {
    const seen = stub({ status: 500 })
    expect(await build(T2BOT).notify({ body: 'b' })).toBe(false)
    expect(seen).toHaveLength(1)
  })

  test('direct: a failed /login aborts (nothing else is attempted)', async () => {
    const seen = stub({ status: 403 })
    expect(await build(DIRECT).notify({ body: 'b' })).toBe(false)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe(
      'https://matrix.example.com/_matrix/client/v3/login',
    )
  })

  test('direct: a 200 /login WITHOUT an access_token aborts', async () => {
    const seen = stub({ status: 200, body: '{}' })
    expect(await build(DIRECT).notify({ body: 'b' })).toBe(false)
    expect(seen).toHaveLength(1)
  })

  test('direct: a failed room join fails the notify (no m.room.message sent)', async () => {
    const seen = stub({ status: 200, body: LOGIN_OK }, { status: 404 })
    expect(await build(DIRECT).notify({ body: 'b' })).toBe(false)
    expect(seen.map((r) => r.method)).toEqual(['POST', 'POST'])
    expect(seen[1]?.url).toContain('/_matrix/client/v3/join/')
  })

  test('direct: a failed message PUT fails the notify', async () => {
    const seen = stub(
      { status: 200, body: LOGIN_OK },
      { status: 200, body: '{"room_id": "!abc:matrix.example.com"}' },
      { status: 500 },
    )
    expect(await build(DIRECT).notify({ body: 'b' })).toBe(false)
    expect(seen).toHaveLength(3)
    expect(seen[2]?.method).toBe('PUT')
    expect(seen[2]?.url).toContain('/send/m.room.message/')
  })

  test('an invalid msgtype / version / mode is rejected at construction', () => {
    expect(() => build(`${DIRECT}&msgtype=bogus`)).toThrow(/msgtype/i)
    expect(() => build(`${DIRECT}&version=v2`)).toThrow(/version/i)
    expect(() => build(`${DIRECT}&mode=bogus`)).toThrow(/mode/i)
  })
})
