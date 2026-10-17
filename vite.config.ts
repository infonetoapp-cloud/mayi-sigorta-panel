import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

// Vite sınır denetleme eklentisi: İstemci derlemesine sunucu kodlarının sızmasını derleme anında engeller.
function serverBoundaryPlugin() {
  return {
    name: 'enforce-server-client-boundary',
    resolveId(source: string, importer?: string) {
      if (!importer) return null;
      const normalizedImporter = importer.replace(/\\/g, '/');
      const isClientOrShared =
        normalizedImporter.includes('/src/app/') || normalizedImporter.includes('/src/shared/');

      if (isClientOrShared) {
        const normalizedSource = source.replace(/\\/g, '/');
        if (
          normalizedSource.includes('/src/server/') ||
          normalizedSource.includes('/server/') ||
          normalizedSource.startsWith('../server') ||
          normalizedSource.startsWith('./server') ||
          normalizedSource === '@server' ||
          normalizedSource.startsWith('@server/')
        ) {
          throw new Error(
            `[MİMARİ SINIR İHLALİ] İstemci/paylaşılan modül ("${importer}") sunucu modülünü ("${source}") içe aktaramaz! ` +
              `Sunucu kodları ve gizli anahtarlar istemci demetine (client bundle) sızdırılamaz.`,
          );
        }
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serverBoundaryPlugin()],
  envPrefix: ['VITE_'],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: false,
  },
  resolve: {
    alias: {
      '@app': resolve(import.meta.dirname, 'src/app'),
      '@shared': resolve(import.meta.dirname, 'src/shared'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
