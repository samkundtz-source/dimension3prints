import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  plugins: [],
  server: {
    port: 3000,
    open: true,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'app.html'),
        success: resolve(__dirname, 'success.html'),
        admin: resolve(__dirname, 'admin.html'),
      },
    },
  },
  // Ensure Leaflet's PNG assets are handled
  assetsInclude: ['**/*.png', '**/*.jpg', '**/*.gif'],
})
