import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/plugins/custom-json.ts',
    'src/plugins/custom-form.ts',
    'src/plugins/custom-xml.ts',
    'src/plugins/apprise-api.ts',
    'src/plugins/mattermost.ts',
    'src/plugins/discord.ts',
    'src/plugins/slack.ts',
    'src/plugins/telegram.ts',
    'src/plugins/rocketchat.ts',
    'src/plugins/matrix.ts',
    'src/plugins/all.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
})
