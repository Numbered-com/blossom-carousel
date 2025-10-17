# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Blossom Carousel is a native-scroll-first carousel component library with physics-based drag support. It provides a core implementation and framework-specific wrappers for React, Vue, Svelte, Alpine.js, and Web Components.

**Key characteristics:**
- Native scrolling with CSS scroll-snap support
- Custom drag physics for fine pointer devices (mouse/trackpad) only - 0kb on touch devices
- Conditional loading - physics engine only loads on devices with `(hover: hover) and (pointer: fine)`
- Physics-based momentum scrolling with configurable friction and damping
- Optional repeat/infinite scroll mode (disabled by default on touch devices)
- Rubber banding overscroll effects
- Programmatic navigation with `prev()` and `next()` methods
- Index tracking with custom change events

## Repository Structure

This is a **pnpm workspace monorepo** with the following packages:

- `packages/core` - Core TypeScript library with Vite build ([blossom-carousel.ts](packages/core/src/blossom-carousel.ts:1))
- `packages/react` - React 19 wrapper component
- `packages/vue` - Vue 3 wrapper component
- `packages/svelte` - Svelte wrapper component
- `packages/alpine` - Alpine.js plugin wrapper
- `packages/web` - Web Component implementation
- `packages/dev` - Development sandbox (Vue-based)

All framework wrappers depend on `@numbered/carousel/core` and provide thin component layers that initialize/destroy the core Blossom instance.

## Development Commands

Use pnpm for all package management:

```bash
# Install dependencies
pnpm install

# Development servers (runs specific package dev server)
pnpm dev              # Run dev sandbox (packages/dev)
pnpm dev:react        # Run React package dev server
pnpm dev:vue          # Run Vue package dev server
pnpm dev:svelte       # Run Svelte package dev server
pnpm dev:alpine       # Run Alpine.js package dev server
pnpm dev:web          # Run Web Component package dev server

# Build individual packages
cd packages/core && pnpm build
cd packages/react && pnpm build
# etc...
```

## Core Architecture

### Main Entry Point
[packages/core/src/blossom-carousel.ts](packages/core/src/blossom-carousel.ts:15) exports the `Blossom` factory function which accepts:
- `scroller: HTMLElement` - The scrollable container element
- `options: CarouselOptions` - Configuration options:
  - `repeat?: boolean` - Enable infinite scroll mode (automatically disabled on touch devices)
  - `load?: 'always'` - Force physics loading on all devices including touch

Returns an object with:
- `init()` - Initialize the carousel
- `destroy()` - Clean up and remove event listeners
- `prev()` - Navigate to previous slide
- `next()` - Navigate to next slide
- `snap` - Boolean indicating if snap is enabled
- `hasOverflow` - Proxy object tracking overflow state

### Physics System
The carousel uses a custom physics ticker ([tick function](packages/core/src/blossom-carousel.ts:423)) with:
- **Friction** (`FRICTION = 0.72`) - Applied to velocity each frame
- **Damping** (`DAMPING = 0.12`) - Smooth interpolation using exponential decay via `damp()` function
- **Velocity projection** - Predicts final resting position for snap point selection
- **Rubber banding** - 0.2x resistance when dragging beyond edges

### Key Systems
1. **Conditional loading** - Physics engine only loads on devices with `(hover: hover) and (pointer: fine)` media query, touch devices use native CSS scroll-snap
2. **Pointer interaction** - Only activates on fine pointer devices (mouse/trackpad)
3. **Scroll interception** - Patches `scrollTo`, `scrollBy`, and `Element.prototype.scrollIntoView` to disable physics during programmatic scrolling
4. **Snap point calculation** - Traverses DOM to find elements with `scroll-snap-align`, computes their positions relative to scroll container
5. **Virtual snap points** - Improved slide positioning system for more precise alignment
6. **Repeat mode** - Translates slides to create infinite scroll illusion, resets scroll position when reaching edges (disabled on touch devices)
7. **Index tracking** - Dispatches custom `change` events with `detail.index` when the active slide changes
8. **Navigation methods** - `prev()` and `next()` methods for programmatic slide navigation

### Important State Variables
- `virtualScroll` - The smoothed scroll position updated by physics ticker
- `target` - The target scroll position (updated by drag or velocity)
- `velocity` - Current momentum vector
- `isDragging` - Pointer down state
- `isTicking` - Whether the animation frame loop is active
- `hasOverflow` - Proxy that adds/removes event listeners when overflow changes

## Framework Wrappers

All wrappers follow the same pattern:
1. Accept children/slots and forward props to rendered element
2. Create a ref to the DOM element
3. Call `Blossom(element, options)` on mount
4. Call `blossom.init()` to start
5. Call `blossom.destroy()` on unmount

Example: [packages/react/src/BlossomCarousel.tsx](packages/react/src/BlossomCarousel.tsx:32)

### React Wrapper
- React 19 compatible
- Uses custom `onChange` event pattern instead of traditional props
- Dispatches custom `change` events with index information
- Example: `<BlossomCarousel repeat={true} />`

### Alpine.js Wrapper
- Registered as an Alpine.js plugin via `Alpine.data('carousel', ...)`
- Provides reactive `currentIndex` property
- Exposes `prev()` and `next()` methods in the component scope
- Listens for custom `change` events to update reactive state
- Example: `<div x-data="carousel({ load: 'always' })">...</div>`

### Custom Events
All framework wrappers dispatch a standard `change` event on the carousel element:
```javascript
// Event structure
new CustomEvent('change', {
  detail: { index: number }
})

// Listening for changes
carouselElement.addEventListener('change', (e) => {
  console.log('Current index:', e.detail.index)
})
```

## Mobile & Performance Optimization

### Conditional Loading Strategy
Blossom Carousel uses a smart loading strategy to optimize for different device types:

**Desktop/Laptop (fine pointer devices)**
- Full physics engine loads (~5-10kb)
- Custom drag interactions with momentum
- Physics-based scrolling with friction and damping
- Rubber banding effects

**Mobile/Touch devices**
- Physics engine does NOT load (0kb overhead)
- Native CSS `scroll-snap-type` handles snapping
- Native touch scrolling for optimal performance
- No repeat mode (infinite scroll disabled)

**Detection**
```javascript
const hasMouse = window.matchMedia('(hover: hover) and (pointer: fine)').matches
```

**Force loading on all devices**
```javascript
Blossom(element, { load: 'always' })
```

### Performance Features
- **Passive event listeners** - Scroll performance optimization
- **ResizeObserver** - Efficient dimension updates
- **MutationObserver** - Automatic recalculation when slides change
- **RequestAnimationFrame** - Smooth 60fps animations
- **Scroll interception** - Prevents physics conflicts during programmatic scrolling

## Publishing

Packages use `publishConfig.access: "public"` and are built to `dist/` directories with:
- UMD build: `dist/blossom-carousel-{package}.umd.cjs`
- ESM build: `dist/blossom-carousel-{package}.js`
- Types: `dist/index.d.ts`
- Styles: `dist/blossom-carousel-{package}.css`

Vite is used for all builds with `vite-plugin-dts` for TypeScript declarations.
