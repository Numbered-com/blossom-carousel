import path from 'node:path'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

export default defineConfig({
	plugins: [dts()],
	resolve: {
		alias: {
			'@numbered/carousel/style.css': path.resolve(__dirname, '../core/dist/carousel.css'),
		},
	},
	build: {
		lib: {
			entry: path.resolve(__dirname, 'src/index.ts'),
			name: 'BlossomCarousel',
			fileName: 'blossom-carousel-alpine',
		},
		rollupOptions: {
			external: ['alpinejs', '@numbered/carousel'],
			output: {
				globals: {
					alpinejs: 'Alpine',
					'@numbered/carousel': 'BlossomCarouselCore',
				},
			},
		},
	},
})
