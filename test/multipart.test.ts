// SPDX-License-Identifier: BSD-2-Clause
// escapeMultipartFilename unit test. Locks the header-injection guard shared by
// the discord/telegram/slack multipart builders: a filename carrying `"`, CR, or
// LF must be percent-encoded so it can never break out of `filename="..."`.

import { describe, expect, test } from 'vitest'
import { escapeMultipartFilename } from '../src/core/multipart.js'

describe('escapeMultipartFilename', () => {
  test('clean names pass through unchanged (fixtures stay byte-identical)', () => {
    expect(escapeMultipartFilename('note.txt')).toBe('note.txt')
    expect(escapeMultipartFilename('photo.png')).toBe('photo.png')
  })

  test('quote / CR / LF are percent-encoded (no header injection)', () => {
    expect(escapeMultipartFilename('a"b')).toBe('a%22b')
    expect(escapeMultipartFilename('a\rb')).toBe('a%0Db')
    expect(escapeMultipartFilename('a\nb')).toBe('a%0Ab')
    expect(escapeMultipartFilename('x"\r\nContent-Type: evil')).toBe(
      'x%22%0D%0AContent-Type: evil',
    )
  })
})
