// SPDX-License-Identifier: BSD-2-Clause
// Attachment tests (core-foundation, group B — task 4.2/4.4).
// Behaviour mirrors upstream attachment/{base,file,memory}.py @ v1.12.0.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
let spacedPath: string
let escapePath: string
let subDir: string
const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'apprise-attach-'))
  jpgPath = join(dir, 'photo.jpg')
  writeFileSync(jpgPath, jpgBytes)
  // A name whose percent-encoding is VALID (`%20` -> space) and one whose
  // percent-encoding is INVALID (`%ZZ` decodes to nothing; Python `unquote`
  // leaves an invalid escape verbatim, so the literal name is the target).
  spacedPath = join(dir, 'my photo.jpg')
  writeFileSync(spacedPath, jpgBytes)
  escapePath = join(dir, '%ZZ.txt')
  writeFileSync(escapePath, 'raw')
  subDir = join(dir, 'subdir')
  mkdirSync(subDir)
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
  test('a name with no extension at all -> null', () => {
    // upstream mimetypes.guess_type("README") -> (None, None).
    expect(guessMimetype('README')).toBeNull()
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

  test('a directory is not a regular file -> inaccessible', () => {
    // upstream file.py: `not os.path.isfile(path)` -> exists() False.
    const attach = new AttachFile(subDir)
    expect(attach.exists()).toBe(false)
    expect(attach.mimetype).toBeNull()
    expect(() => attach.base64()).toThrow(/Attachment Missing/)
  })

  test('a forced name is returned even when the file is missing (mimetype is not)', () => {
    // upstream base.py `name` returns self._name BEFORE calling exists(), while
    // `mimetype` checks exists() FIRST and returns None.
    const attach = new AttachFile(join(dir, 'gone.bin'), { name: 'forced.txt' })
    expect(attach.exists()).toBe(false)
    expect(attach.name).toBe('forced.txt')
    expect(attach.mimetype).toBeNull()
  })

  test('a forced name with no extension yields the unknown mimetype', () => {
    const attach = new AttachFile(jpgPath, { name: 'README' })
    expect(attach.name).toBe('README')
    expect(attach.mimetype).toBe(UNKNOWN_MIMETYPE)
  })
})

describe('AttachFile via a file:// URL (upstream parse_url + unquote)', () => {
  test('percent escapes are decoded (%20 -> space)', () => {
    const container = new AppriseAttachment(`file://${dir}/my%20photo.jpg`)
    expect(container.attachments[0]?.exists()).toBe(true)
    expect(container.attachments[0]?.name).toBe('my photo.jpg')
  })

  test('a query string is stripped from the path', () => {
    const container = new AppriseAttachment(`file://${jpgPath}?cache=no`)
    expect(container.attachments[0]?.exists()).toBe(true)
    expect(container.attachments[0]?.name).toBe('photo.jpg')
  })

  test('an INVALID percent escape is left verbatim (Python unquote semantics)', () => {
    // Python unquote("%ZZ.txt") == "%ZZ.txt" — the file literally named "%ZZ.txt"
    // is the target, so it must resolve.
    const container = new AppriseAttachment(`file://${dir}/%ZZ.txt`)
    expect(container.attachments[0]?.exists()).toBe(true)
    expect(container.attachments[0]?.name).toBe('%ZZ.txt')
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

  test('an unsupported value type fails to add', () => {
    const container = new AppriseAttachment()
    expect(container.add(42 as never)).toBe(false)
    expect(container.length).toBe(0)
  })

  test('constructing from an unaddable source throws (upstream TypeError)', () => {
    expect(() => new AppriseAttachment('memory://noop')).toThrow(
      'One or more attachments could not be added.',
    )
  })

  test('pop() removes the last entry; pop(0) removes the first', () => {
    const a = new AttachMemory({ content: 'a', name: 'a.txt' })
    const b = new AttachMemory({ content: 'b', name: 'b.txt' })
    const c = new AttachMemory({ content: 'c', name: 'c.txt' })
    const container = new AppriseAttachment([a, b, c])
    expect(container.pop()?.name).toBe('c.txt')
    expect(container.pop(0)?.name).toBe('a.txt')
    expect([...container].map((x) => x.name)).toEqual(['b.txt'])
  })

  test('clear() empties the container', () => {
    const container = new AppriseAttachment(
      new AttachMemory({ content: 'a', name: 'a.txt' }),
    )
    container.clear()
    expect(container.length).toBe(0)
    expect(container.valid).toBe(false)
  })
})
