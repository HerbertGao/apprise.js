import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/plugins/custom-json.ts',
    'src/plugins/custom-form.ts',
    'src/plugins/custom-xml.ts',
    'src/plugins/apprise-api.ts',
    'src/plugins/all.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
})
