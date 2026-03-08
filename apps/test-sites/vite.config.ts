import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        form: resolve(__dirname, 'form.html'),
        table: resolve(__dirname, 'table.html'),
        controlled: resolve(__dirname, 'controlled.html'),
        spa: resolve(__dirname, 'spa.html'),
        iframeHost: resolve(__dirname, 'iframe-host.html'),
        iframeChild: resolve(__dirname, 'iframe-child.html'),
        shadow: resolve(__dirname, 'shadow.html'),
        upload: resolve(__dirname, 'upload.html'),
        network: resolve(__dirname, 'network.html')
      }
    }
  }
});
