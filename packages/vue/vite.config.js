import path from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

export default defineConfig({
	plugins: [vue(), dts()],
	build: {
		lib: {
			entry: path.resolve(__dirname, 'src/index.ts'),
			name: 'BlossomCarousel',
			fileName: 'blossom-carousel-vue',
		},
		rollupOptions: {
			// Don't bundle Vue, expect the app to provide it
			external: ['vue', '@numbered/carousel'],
			output: {
				globals: {
					vue: 'Vue',
					'@numbered/carousel': 'BlossomCarouselCore',
				},
			},
		},
	},
})
