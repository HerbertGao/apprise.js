// SPDX-License-Identifier: BSD-2-Clause
// apprise.js — a faithful TypeScript translation of caronc/apprise.
// Derived from https://github.com/caronc/apprise (© Chris Caron), BSD-2-Clause.
//
// Convenience bucket: importing this module registers ALL in-scope plugins in
// one go — the four batch-1 meta-plugins (json/jsons, form/forms, xml/xmls,
// apprise/apprises) plus the six IM plugins (mmost/mmosts, discord, slack,
// tgram, rocket/rockets, matrix/matrixs). Importing a SINGLE plugin entry
// instead registers only that plugin's schemes, so bundlers can tree-shake
// unused plugins away (design.md Decision 4).

import './custom-json.js'
import './custom-form.js'
import './custom-xml.js'
import './apprise-api.js'
import './mattermost.js'
import './discord.js'
import './slack.js'
import './telegram.js'
import './rocketchat.js'
import './matrix.js'
import './serverchan.js'
import './dingtalk.js'
import './wecombot.js'
import './feishu.js'
import './lark.js'
import './wxpusher.js'
import './pushdeer.js'
