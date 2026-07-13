// SPDX-License-Identifier: BSD-2-Clause
// Attachment tests (core-foundation, group B — task 4.2/4.4).
// Behaviour mirrors upstream attachment/{base,file,memory}.py @ v1.12.0.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  AppriseAttachment,
  guessMimetype,
  UNKNOWN_MIMETYPE,
} from '../src/attachment/base.js'
import { AttachFile } from '../src/attachment/file.js'
import { AttachMemory } from '../src/attachment/memory.js'

const UUID_RE = /^[0-9a-f-]{36}\.(txt|dat)$/i

let dir: string
let jpgPath: string
const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'apprise-attach-'))
  jpgPath = join(dir, 'photo.jpg')
  writeFileSync(jpgPath, jpgBytes)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('guessMimetype (fixed MIME map)', () => {
  test('.jpg -> image/jpeg', () => {
    expect(guessMimetype('photo.jpg')).toBe('image/jpeg')
  })
  test('.png -> image/png', () => {
    expect(guessMimetype('a.PNG')).toBe('image/png')
  })
  test('unknown extension -> null (falls back to octet-stream)', () => {
    expect(guessMimetype('a.zzz')).toBeNull()
  })
})

describe('AttachFile', () => {
  test('reads bytes, size, mimetype from extension', () => {
    const attach = new AttachFile(jpgPath)
    expect(attach.exists()).toBe(true)
    expect(attach.name).toBe('photo.jpg')
    expect(attach.mimetype).toBe('image/jpeg')
    expect(attach.size).toBe(jpgBytes.length)
    expect(attach.base64()).toBe(jpgBytes.toString('base64'))
  })

  test('missing file is reported as failure, not a crash', () => {
    const attach = new AttachFile(join(dir, 'nope.txt'))
    expect(attach.exists()).toBe(false)
    expect(attach.size).toBe(0)
    expect(attach.name).toBeNull()
    expect(attach.mimetype).toBeNull()
    expect(() => attach.base64()).toThrow(/Attachment Missing/)
  })

  test('forced mimetype overrides inference', () => {
    const attach = new AttachFile(jpgPath, { mimetype: 'image/custom' })
    expect(attach.mimetype).toBe('image/custom')
  })
})

describe('AttachMemory', () => {
  test('string content -> text/plain + uuid .txt name', () => {
    const attach = new AttachMemory({ content: 'hello world' })
    expect(attach.mimetype).toBe('text/plain')
    expect(attach.name).toMatch(UUID_RE)
    expect(attach.name?.endsWith('.txt')).toBe(true)
    expect(attach.base64()).toBe(Buffer.from('hello world').toString('base64'))
  })

  test('binary content without mimetype falls back to octet-stream + .dat', () => {
    const attach = new AttachMemory({ content: Buffer.from([1, 2, 3]) })
    expect(attach.mimetype).toBe(UNKNOWN_MIMETYPE)
    expect(attach.name).toMatch(UUID_RE)
    expect(attach.name?.endsWith('.dat')).toBe(true)
  })

  test('explicit mimetype is used verbatim (no re-inference)', () => {
    const attach = new AttachMemory({
      content: Buffer.from([1, 2, 3]),
      mimetype: 'image/png',
    })
    expect(attach.mimetype).toBe('image/png')
  })

  test('explicit name is preserved', () => {
    const attach = new AttachMemory({ content: 'x', name: 'note.txt' })
    expect(attach.name).toBe('note.txt')
  })

  test('empty content is inaccessible', () => {
    const attach = new AttachMemory({})
    expect(attach.exists()).toBe(false)
    expect(attach.size).toBe(0)
  })
})

describe('AppriseAttachment container', () => {
  test('holds AttachBase instances and reports size', () => {
    const container = new AppriseAttachment()
    expect(container.valid).toBe(false)
    container.add(new AttachMemory({ content: 'abc', name: 'a.txt' }))
    container.add(new AttachFile(jpgPath))
    expect(container.length).toBe(2)
    expect(container.valid).toBe(true)
    expect(container.size()).toBe(3 + jpgBytes.length)
    expect([...container].map((a) => a.name)).toEqual(['a.txt', 'photo.jpg'])
  })

  test('adds a bare file path as a file attachment', () => {
    const container = new AppriseAttachment(jpgPath)
    expect(container.length).toBe(1)
    expect(container.attachments[0]?.mimetype).toBe('image/jpeg')
  })

  test('a nested container is flattened', () => {
    const inner = new AppriseAttachment(
      new AttachMemory({ content: 'y', name: 'y.txt' }),
    )
    const outer = new AppriseAttachment()
    expect(outer.add(inner)).toBe(true)
    expect(outer.length).toBe(1)
  })

  test('unsupported scheme fails to add', () => {
    const container = new AppriseAttachment()
    expect(container.add('memory://noop')).toBe(false)
    expect(container.length).toBe(0)
  })
})
