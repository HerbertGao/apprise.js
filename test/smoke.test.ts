import { expect, test } from 'vitest'
import { UPSTREAM_VERSION } from '../src/index.js'

test('toolchain smoke: package exports the pinned upstream baseline', () => {
  expect(UPSTREAM_VERSION).toBe('1.12.0')
})
