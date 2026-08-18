import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: 'esm',
  dts: true,
  sourcemap: true,
  clean: true,
  platform: 'node',
  target: 'node22',
  fixedExtension: false,
  hash: false,
  deps: { neverBundle: [/^@deepseek-ai\//] },
})
