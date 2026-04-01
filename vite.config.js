import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 3000,
    open: true,
  },
  // Ensure Leaflet's PNG assets are handled
  assetsInclude: ['**/*.png', '**/*.jpg', '**/*.gif'],
})
