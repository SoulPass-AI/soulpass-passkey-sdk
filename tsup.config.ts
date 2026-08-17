import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    protocol: 'src/protocol-entry.ts',
    react: 'src/react/index.tsx',
    payments: 'src/payments-entry.ts',
    'payments-react': 'src/payments/react.tsx',
    'adapters/solana': 'src/adapters/solana.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: true,
})
