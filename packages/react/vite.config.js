import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

export default defineConfig({
	plugins: [react(), dts()],
	build: {
		lib: {
			entry: path.resolve(__dirname, 'src/index.ts'),
			name: 'BlossomCarousel',
			fileName: 'blossom-carousel-react',
		},
		rollupOptions: {
			external: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@numbered/carousel'],
			output: {
				globals: {
					react: 'React',
					'react-dom': 'ReactDOM',
					'react/jsx-runtime': 'React',
					'react/jsx-dev-runtime': 'React',
					'@numbered/carousel': 'BlossomCarouselCore',
				},
			},
		},
	},
})
