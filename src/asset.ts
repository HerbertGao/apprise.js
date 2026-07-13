// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
// Translation baseline: upstream v1.12.0 (apprise/asset.py).

import { randomUUID } from 'node:crypto'
import type { NotifyFormat } from './common.js'
import { NotifyImageSize, type NotifyType } from './common.js'

const IMAGE_URL_MASK =
  'https://github.com/caronc/apprise/raw/master/apprise/assets/' +
  'themes/{THEME}/apprise-{TYPE}-{XY}{EXTENSION}'

const IMAGE_URL_LOGO =
  'https://github.com/caronc/apprise/raw/master/apprise/assets/' +
  'themes/{THEME}/apprise-logo.png'

/** Settable fields accepted by the {@link AppriseAsset} constructor. */
export interface AppriseAssetOptions {
  appId?: string
  appDesc?: string
  appUrl?: string
  theme?: string
  defaultExtension?: string
  defaultImageSize?: NotifyImageSize
  imageUrlMask?: string
  imageUrlLogo?: string
  bodyFormat?: NotifyFormat | null
  /** Pinnable for golden-differential determinism (apprise-api `X-Apprise-ID`). */
  uid?: string
  /** Pinnable (apprise-api `X-Apprise-Recursion-Count` = `recursion + 1`). */
  recursion?: number
}

/**
 * Carries application-level presentation metadata (upstream `AppriseAsset`).
 * The in-scope display fields (app id/desc/url, theme, format, image
 * templates, uid) mirror upstream 1:1; PGP/PEM and persistent-storage members
 * are non-goals for batch-1 and exist only as inert placeholders below.
 */
export class AppriseAsset {
  appId = 'Apprise'
  appDesc = 'Apprise Notifications'
  appUrl = 'https://github.com/caronc/apprise'

  theme = 'default'
  defaultExtension = '.png'
  defaultImageSize: NotifyImageSize = NotifyImageSize.XY_256
  imageUrlMask = IMAGE_URL_MASK
  imageUrlLogo = IMAGE_URL_LOGO

  /** Source format assumed for a `notify()` body when none is given. */
  bodyFormat: NotifyFormat | null = null

  /** Unique id — apprise-api emits this as `X-Apprise-ID`. Pinnable. */
  uid: string = randomUUID()

  /** Recursion counter — apprise-api emits `recursion + 1`. Pinnable. */
  recursion = 0

  // ponytail: non-target no-op placeholders (asset.py:170-218). PGP/PEM key
  // autogen and persistent storage are batch-1 non-goals; kept only so the
  // public shape acknowledges them. They carry no behaviour and are not part
  // of the "1:1 upstream" acceptance surface. Wire real behaviour with the
  // PGP / persistent-store milestones.
  pgpAutogen = true
  pemAutogen = true

  constructor(options: AppriseAssetOptions = {}) {
    Object.assign(this, options)
  }

  /**
   * Resolve the icon/image URL for a notify type and size (upstream
   * `asset.py:image_url`). Returns `null` when the relevant mask is empty.
   */
  imageUrl(
    notifyType: NotifyType,
    imageSize: NotifyImageSize = this.defaultImageSize,
    options: { logo?: boolean; extension?: string } = {},
  ): string | null {
    const urlMask = options.logo ? this.imageUrlLogo : this.imageUrlMask
    if (!urlMask) {
      // No image to return
      return null
    }

    const extension = options.extension ?? this.defaultExtension

    const reMap: Record<string, string> = {
      '{THEME}': this.theme || '',
      '{TYPE}': notifyType,
      '{XY}': imageSize,
      '{EXTENSION}': extension,
    }

    // Case-insensitive placeholder substitution, matching upstream's
    // re.IGNORECASE compiled table.
    return urlMask.replace(
      /\{THEME\}|\{TYPE\}|\{XY\}|\{EXTENSION\}/gi,
      (match) => reMap[match.toUpperCase()] ?? match,
    )
  }
}
