import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/GeoConverterProEA/',

  // Web Worker'lar ES modül olarak paketlenir (worker içinde `import` kullanılabilsin).
  worker: {
    format: 'es',
  },

  build: {
    // Vite 8 (Rolldown): `rollupOptions`/`manualChunks` yerine `rolldownOptions` + `codeSplitting.groups`.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 3,
            },
            {
              name: 'leaflet-vendor',
              test: /node_modules[\\/](leaflet|react-leaflet|@react-leaflet)[\\/]/,
              priority: 2,
            },
          ],
        },
      },
    },
  },

  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
  },
})
