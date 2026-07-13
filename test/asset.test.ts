// SPDX-License-Identifier: BSD-2-Clause
// AppriseAsset tests (core-foundation, group B — task 4.1/4.4).
// Oracle image URLs are derived from upstream asset.py image_url_mask +
// image_url() substitution @ v1.12.0.

import { describe, expect, test } from 'vitest'
import { AppriseAsset } from '../src/asset.js'
import { NotifyImageSize, NotifyType } from '../src/common.js'

describe('AppriseAsset defaults mirror upstream', () => {
  test('display metadata defaults', () => {
    const asset = new AppriseAsset()
    expect(asset.appId).toBe('Apprise')
    expect(asset.appDesc).toBe('Apprise Notifications')
    expect(asset.appUrl).toBe('https://github.com/caronc/apprise')
    expect(asset.theme).toBe('default')
    expect(asset.defaultExtension).toBe('.png')
    expect(asset.defaultImageSize).toBe(NotifyImageSize.XY_256)
    expect(asset.bodyFormat).toBeNull()
  })

  test('default asset has a uuid uid and recursion 0', () => {
    const asset = new AppriseAsset()
    expect(asset.uid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    expect(asset.recursion).toBe(0)
  })

  test('uid / recursion are pinnable for golden determinism', () => {
    const asset = new AppriseAsset({ uid: 'pinned-uid', recursion: 2 })
    expect(asset.uid).toBe('pinned-uid')
    expect(asset.recursion).toBe(2)
  })
})

describe('AppriseAsset.imageUrl resolves by type + size', () => {
  const base =
    'https://github.com/caronc/apprise/raw/master/apprise/assets/themes'

  test('warning at default size', () => {
    const asset = new AppriseAsset()
    expect(asset.imageUrl(NotifyType.WARNING)).toBe(
      `${base}/default/apprise-warning-256x256.png`,
    )
  })

  test('info at an explicit size', () => {
    const asset = new AppriseAsset()
    expect(asset.imageUrl(NotifyType.INFO, NotifyImageSize.XY_32)).toBe(
      `${base}/default/apprise-info-32x32.png`,
    )
  })

  test('logo ignores type/size', () => {
    const asset = new AppriseAsset()
    expect(asset.imageUrl(NotifyType.FAILURE, undefined, { logo: true })).toBe(
      `${base}/default/apprise-logo.png`,
    )
  })

  test('explicit extension override', () => {
    const asset = new AppriseAsset()
    expect(
      asset.imageUrl(NotifyType.SUCCESS, NotifyImageSize.XY_128, {
        extension: '.jpg',
      }),
    ).toBe(`${base}/default/apprise-success-128x128.jpg`)
  })

  test('empty mask yields null', () => {
    const asset = new AppriseAsset({ imageUrlMask: '' })
    expect(asset.imageUrl(NotifyType.INFO)).toBeNull()
  })
})
