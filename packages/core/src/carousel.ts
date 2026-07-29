interface Point {
	x: number
	y: number
}

// Single shared Element.prototype.scrollIntoView patch, refcounted across instances,
// so destroying instances out of init order can't leave a stale wrapper installed.
const scrollIntoViewSubscribers = new Set<(target: Element) => void>()
let originalScrollIntoView: typeof Element.prototype.scrollIntoView | null = null
let patchedScrollIntoView: typeof Element.prototype.scrollIntoView | null = null

function interceptScrollIntoViewCalls(onExternalScroll: (target: Element) => void): () => void {
	scrollIntoViewSubscribers.add(onExternalScroll)

	if (!originalScrollIntoView) {
		originalScrollIntoView = Element.prototype.scrollIntoView
		patchedScrollIntoView = Element.prototype.scrollIntoView = function (arg?: boolean | ScrollIntoViewOptions): void {
			for (const subscriber of scrollIntoViewSubscribers) subscriber(this)
			originalScrollIntoView?.call(this, arg)
		}
	}

	return () => {
		scrollIntoViewSubscribers.delete(onExternalScroll)
		if (scrollIntoViewSubscribers.size === 0 && originalScrollIntoView) {
			// Only restore if we're still the installed patch; if another library patched
			// over ours, leave theirs in place (our wrapper just delegates once we're empty).
			if (Element.prototype.scrollIntoView === patchedScrollIntoView) {
				Element.prototype.scrollIntoView = originalScrollIntoView
			}
			originalScrollIntoView = null
			patchedScrollIntoView = null
		}
	}
}

interface HasOverflow {
	x: boolean
	y: boolean
}

export interface CarouselOptions {
	repeat?: boolean
}

interface CurrentIndex {
	value: number
	onChange: ((index: number) => void) | null
}

export const Blossom = (scroller: HTMLElement, options: CarouselOptions) => {
	let snap = <boolean>true
	const pointerStart: Point = { x: 0, y: 0 }
	const target: Point = { x: 0, y: 0 }
	const velocity: Point = { x: 0, y: 0 }
	const distanceMovedSincePointerDown: Point = new Proxy(
		{ x: 0, y: 0 },
		{
			set(target, prop: keyof Point, value) {
				if (!nativeScroll) {
					const old = target[prop]
					if (old === value) return true

					target[prop] = value

					if (target.x >= 10 || target.y >= 10) {
						setIsTicking(true)
					}
				}

				return true
			},
		},
	)

	const hasOverflow: HasOverflow = new Proxy(
		{ x: false, y: false },
		{
			set(target, prop: keyof HasOverflow, value) {
				const old = target[prop]
				if (old === value) return true

				target[prop] = value

				if (target.x || target.y) {
					scroller.setAttribute('has-overflow', 'true')
					// Passive: none of these handlers ever preventDefault, and non-passive
					// wheel/touch listeners block the compositor scroll thread.
					scroller.addEventListener('touchstart', onPointerDown, { passive: true })
					scroller.addEventListener('pointerdown', onPointerDown, { passive: true })
					scroller.addEventListener('wheel', onWheel, { passive: true })
				} else {
					scroller.removeAttribute('has-overflow')
					scroller.removeEventListener('touchstart', onPointerDown)
					scroller.removeEventListener('pointerdown', onPointerDown)
					scroller.removeEventListener('wheel', onWheel)
				}

				return true
			},
		},
	)

	const currentIndex: CurrentIndex = new Proxy(
		{ value: 0, onChange: null },
		{
			set(target, prop: keyof CurrentIndex, value: any) {
				const old = target[prop]
				if (old === value) return true

				;(target as any)[prop] = value

				// Dispatch custom event when value changes
				if (prop === 'value') {
					const event = new CustomEvent('change', {
						bubbles: true,
						detail: { index: value },
					})
					scroller?.dispatchEvent(event)
				}

				return true
			},
		},
	)

	let end = 300
	let raf: number | null = null
	let isDragging = false
	let scrollerScrollWidth = 300
	let scrollerWidth = 300
	let scrollerScrollHeight = 300
	let scrollerHeight = 300
	const securityMargin = 0
	const padding = { start: 0, end: 0 }
	const scrollPadding = { start: 0, end: 0 }
	let gap = 0
	let snapPoints: number[] = []
	let snapElements: HTMLElement[] = []
	let snapAlignments: ScrollLogicalPosition[] = []
	let snapWidths: number[] = []
	let snapCandidates: { el: HTMLElement; align: string }[] = []
	const virtualSnapPoints: number[] = []
	let slides: HTMLElement[] = []
	let resizeObserver: ResizeObserver | null = null
	let mutationObserver: MutationObserver | null = null
	// Observer callbacks are coalesced into one sync per microtask; structureDirty
	// records whether any of them implied a child-list change.
	let structureDirty = false
	let syncScheduled = false
	let initialised = false
	let candidatesResolved = false
	let deepCandidates = false
	let hasSnap = false
	let hasMouse = false
	let nativeScroll = true
	let previousInlineSnapType = ''
	let restoreScrollMethods: () => void
	let dir = 1

	function init() {
		// Re-entrant: a second init() without destroy() would otherwise strand the previous
		// observers, listeners and scrollIntoView subscriber.
		if (initialised) destroy()
		initialised = true
		installScrollOverrides()
		scroller?.setAttribute('blossom-carousel', 'true')
		slides = Array.from(scroller.children) as HTMLElement[]

		window.addEventListener('keydown', onKeydown)
		scroller.addEventListener('scroll', onScroll, { passive: true })

		dir = scroller.closest('[dir="rtl"]') ? -1 : 1

		const { scrollSnapType } = window.getComputedStyle(scroller)
		hasSnap = scrollSnapType !== 'none'
		scroller.style.setProperty('--snap-type', scrollSnapType)
		scroller.setAttribute('has-repeat', options?.repeat ? 'true' : 'false')

		hasMouse = window.matchMedia('(hover: hover) and (pointer: fine)').matches

		nativeScroll = !hasMouse && !options?.repeat
		previousInlineSnapType = scroller.style.scrollSnapType
		if (!nativeScroll) {
			scroller.style.scrollSnapType = 'none'
		}

		restoreScrollMethods = interceptScrollIntoViewCalls((target) => {
			if (target === scroller || scroller.contains(target)) setIsTicking(false)
		})

		resizeObserver = new ResizeObserver(() => {
			scheduleSync(false)
		})
		// If scroller width matches parent width, observe parent for resize events
		// (ResizeObserver may not fire on elements sized by their containers)
		const parent = scroller.parentElement
		if (parent && scroller.clientWidth === parent.clientWidth) {
			resizeObserver.observe(parent)
		} else {
			resizeObserver.observe(scroller)
		}

		mutationObserver = new MutationObserver(() => {
			scheduleSync(true)
		})
		mutationObserver.observe(scroller, {
			attributes: false,
			childList: true,
			subtree: false,
		})
	}

	function destroy() {
		scroller.removeAttribute('blossom-carousel')
		resizeObserver?.disconnect()
		mutationObserver?.disconnect()
		if (raf) cancelAnimationFrame(raf)
		raf = null
		// Reset, or a later setIsTicking(true) sees a stale `true` and never restarts the loop
		isTicking = false
		// A pending sync can't be cancelled, so make it a no-op instead
		structureDirty = false
		candidatesResolved = false
		initialised = false

		velocity.x = velocity.y = 0
		rubberBandOffset = 0

		window.removeEventListener('keydown', onKeydown)
		scroller.removeEventListener('scroll', onScroll)
		// A destroy mid-drag would otherwise leave these window listeners live until
		// the next pointerup, still mutating this instance's state.
		removePointerListeners()
		isDragging = false
		scroller.classList.remove('blossom-dragging')
		// Removes the pointer listeners the proxy installed, and lets a later init()
		// re-add them once it re-detects overflow.
		hasOverflow.x = false
		hasOverflow.y = false

		// Undo everything init() wrote. Notably scrollSnapType: leaving our own 'none' on
		// the element makes a later init() read it back as the authored value, conclude the
		// carousel doesn't snap, and come up with no snap points at all.
		clearTranslations()
		scroller.style.scrollSnapType = previousInlineSnapType
		scroller.style.transform = ''
		scroller.style.removeProperty('--snap-type')
		scroller.removeAttribute('has-repeat')
		scroller.removeAttribute('has-snap')

		restoreScrollOverrides?.()
		restoreScrollMethods?.()
	}

	function scheduleSync(structure: boolean): void {
		if (structure) structureDirty = true

		// Coalesce, but flush in a microtask rather than a frame. ResizeObserver callbacks
		// are delivered after rAF and *before* paint, so deferring to the next frame would
		// let one frame paint at the wrong scroll position, a visible blink on open.
		if (syncScheduled) return
		syncScheduled = true
		queueMicrotask(() => {
			syncScheduled = false
			const structureChanged = structureDirty
			structureDirty = false
			sync(structureChanged)
		})
	}

	function sync(structureChanged: boolean): void {
		if (!scroller || !initialised) return

		const widthChanged = scroller.clientWidth !== scrollerWidth
		const resolveStructure =
			structureChanged ||
			!candidatesResolved ||
			// A width change can flip a media query, changing which elements snap and how
			widthChanged ||
			// MutationObserver is childList-only, so a replaced *nested* slide is invisible
			// to it. Cheap to detect, and only possible when we resolved deep candidates.
			(deepCandidates && snapCandidates.some(({ el }) => !scroller.contains(el)))

		// Bail before touching anything if our own box is unchanged and the child list is
		// intact. This is the common case: the ResizeObserver watches the parent, so it
		// fires for page layout changes that never affect the carousel at all.
		// Repeat mode translates slides, which skews scrollWidth, so its measurements are
		// only trustworthy once the translations are cleared, so no early bail there.
		if (
			!resolveStructure &&
			!options?.repeat &&
			scroller.scrollWidth === scrollerScrollWidth &&
			scroller.scrollHeight === scrollerScrollHeight &&
			scroller.clientHeight === scrollerHeight
		) {
			return
		}

		setIsTicking(false)

		// Only write before the read phase, never between reads, so the browser flushes once.
		if (options?.repeat) clearTranslations()
		if (resolveStructure) slides = Array.from(scroller.children) as HTMLElement[]

		scrollerScrollWidth = scroller.scrollWidth
		scrollerWidth = scroller.clientWidth
		scrollerScrollHeight = scroller.scrollHeight
		scrollerHeight = scroller.clientHeight

		const styles = window.getComputedStyle(scroller)
		hasOverflow.x =
			// !hasTouch &&
			scrollerScrollWidth > scrollerWidth && ['auto', 'scroll'].includes(styles.getPropertyValue('overflow-x'))
		hasOverflow.y =
			// !hasTouch &&
			scrollerScrollHeight > scrollerHeight && ['auto', 'scroll'].includes(styles.getPropertyValue('overflow-y'))
		padding.start = Number.parseInt(styles.paddingInlineStart, 10) || 0
		padding.end = Number.parseInt(styles.paddingInlineEnd, 10) || 0
		scrollPadding.start = Number.parseInt(styles.scrollPaddingInlineStart, 10) || 0
		scrollPadding.end = Number.parseInt(styles.scrollPaddingInlineEnd, 10) || 0
		dir = scroller.closest('[dir="rtl"]') ? -1 : 1
		gap = Number.parseInt(styles.gap, 10) || Number.parseInt(styles.columnGap, 10) || 0
		end = (scrollerScrollWidth - scrollerWidth - securityMargin + gap) * dir

		// Which elements snap only changes when the child list changes; their positions
		// change on every resize. Resolving identity is the expensive half, so cache it.
		if (resolveStructure) {
			snapCandidates = hasSnap ? findSnapCandidates() : []
			candidatesResolved = true
		}
		measureSnapPoints()

		// Slides can disappear from under us; keep the index addressable or prev()/next()
		// would compute another out-of-range index and stall permanently.
		if (snapPoints.length && currentIndex.value > snapPoints.length - 1) {
			currentIndex.value = snapPoints.length - 1
		}

		// Repositioning mid-drag would yank the carousel out from under the pointer
		const point = snapPoints[currentIndex.value]
		if (point !== undefined && !isDragging) {
			target.x = virtualScroll.x = point
			scroller.scrollTo({ left: point, behavior: 'instant' })
		}
		if (options?.repeat) {
			onRepeat()
		}
	}

	// Walks descendants but stops at the first snap-aligned element on each branch, so a
	// slide's own rich content is never descended into. The expensive case is a carousel
	// whose slides don't snap at all; that's why the result is cached and only re-resolved
	// when the structure (or a media query, via a width change) could have altered it.
	function findSnapCandidates(): { el: HTMLElement; align: string }[] {
		const found: { el: HTMLElement; align: string }[] = []

		const collect = (children: HTMLCollection) => {
			for (const node of children) {
				// scroll-snap-align is `<block> <inline>`; the inline value drives horizontal snapping
				const parts = window.getComputedStyle(node).scrollSnapAlign.split(' ')
				const align = parts[1] ?? parts[0]

				if (align !== 'none') {
					found.push({ el: node as HTMLElement, align })
					continue
				}
				if (node.children.length) collect(node.children)
			}
		}

		collect(scroller.children)
		deepCandidates = found.some(({ el }) => el.parentElement !== scroller)

		return found
	}

	// Read-only: no style writes may happen between the rect reads below.
	function measureSnapPoints(): void {
		const scrollerRect = scroller.getBoundingClientRect()
		const scrollLeft = scroller.scrollLeft

		snapPoints = []
		snapElements = []
		snapAlignments = []
		snapWidths = []
		const seenPositions = new Set<number>()

		for (const { el, align } of snapCandidates) {
			const elementRect = el.getBoundingClientRect()
			const clientWidth = el.clientWidth
			const left = elementRect.left - scrollerRect.left + scrollLeft

			let position: number | null = null
			switch (align) {
				case 'start':
					position = left - scrollPadding.start
					break
				case 'end':
					position = left + clientWidth - scrollerWidth + scrollPadding.end
					break
				case 'center':
					position = left + clientWidth * 0.5 - scrollerWidth / 2
					break
			}

			// Filter out duplicates (i.e. in case of multiple rows)
			if (position === null || seenPositions.has(position)) continue
			seenPositions.add(position)

			snapPoints.push(position)
			snapElements.push(el)
			snapAlignments.push(align as ScrollLogicalPosition)
			snapWidths.push(clientWidth)
		}
	}

	function onScroll() {
		if (isDragging || !scroller) return

		const scrollStart = scroller.scrollLeft

		if (!isTicking) {
			virtualScroll.x = target.x = scrollStart
		}

		if (options?.repeat) {
			// onRepeat may scroll us elsewhere, so let the index re-read the position
			onRepeat()
			updateCurrentIndex()
			return
		}

		const maxScroll = getMaxScrollPosition()

		if (scrollStart < 0) {
			const left = scrollStart * -1
			dispatchOverscrollEvent(left)
		} else if (scrollStart > maxScroll) {
			const left = scrollStart * -1 + maxScroll
			dispatchOverscrollEvent(left)
		}

		updateCurrentIndex(scrollStart)
	}

	/*********************
	 **** Drag events ****
	 *********************/

	const virtualScroll: Point = {
		x: 0,
		y: 0,
	}

	function addPointerListeners(): void {
		window.addEventListener('pointermove', onPointerMove, { passive: true })
		window.addEventListener('touchmove', onPointerMove, { passive: true })
		window.addEventListener('pointerup', onPointerUp, { passive: true })
		window.addEventListener('touchend', onPointerUp, { passive: true })
	}

	function removePointerListeners(): void {
		window.removeEventListener('pointermove', onPointerMove)
		window.removeEventListener('touchmove', onPointerMove)
		window.removeEventListener('pointerup', onPointerUp)
		window.removeEventListener('touchend', onPointerUp)
	}

	function onPointerDown(e: PointerEvent | TouchEvent): void {
		if (!scroller) return

		const clientX = 'touches' in e ? e.touches[0]?.clientX : e.clientX
		const clientY = 'touches' in e ? e.touches[0]?.clientY : e.clientY

		if (hasOverflow.x) handleAxisPointerDown('x', clientX)
		if (hasOverflow.y) handleAxisPointerDown('y', clientY)

		distanceMovedSincePointerDown.x = 0
		isDragging = true

		addPointerListeners()
	}

	function onPointerMove(e: PointerEvent | TouchEvent): void {
		const clientX = 'touches' in e ? e.touches[0]?.clientX : e.clientX
		const clientY = 'touches' in e ? e.touches[0]?.clientY : e.clientY

		if (hasOverflow.x) handleAxisPointerMove('x', clientX)
		if (hasOverflow.y) handleAxisPointerMove('y', clientY)

		if (distanceMovedSincePointerDown.x > 2 || distanceMovedSincePointerDown.y > 2) scroller.classList.add('blossom-dragging')
	}

	function onPointerUp(): void {
		removePointerListeners()

		isDragging = false
		scroller.classList.remove('blossom-dragging')

		if (distanceMovedSincePointerDown.x <= 10) return
		if (hasOverflow.x) velocity.x *= 2
		if (hasOverflow.y) velocity.y *= 2

		dragSnap()
	}

	function onWheel(e: WheelEvent): void {
		if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
			setIsTicking(false)
			if (isDragging || !scroller) return
			if (hasOverflow.x) virtualScroll.x = scroller.scrollLeft
			if (hasOverflow.y) virtualScroll.y = scroller.scrollTop
		}
	}

	function onKeydown(e: KeyboardEvent): void {
		if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) setIsTicking(false)
	}

	function dragSnap(): void {
		//TODO: add support for vertical snapping
		let slideX: number | undefined

		if (options?.repeat && snapElements.length > 0) {
			// Strict single-step using helpers
			const n = snapPoints.length
			if (n >= 2) {
				const ci = ((currentIndex.value % n) + n) % n
				const step: 1 | -1 = velocity.x * dir >= 0 ? 1 : -1
				const targetIdx = (ci + step + n) % n
				slideX = computeRepeatSlideX(targetIdx, step)
			} else {
				slideX = snapSelect({ axis: 'x' })
			}
		} else if (!options?.repeat && snapElements.length) {
			const bounds = getScrollBounds()
			slideX = clamp(snapSelect({ axis: 'x' }), bounds.min, bounds.max)
		}

		if (slideX === undefined) return

		animateToSlideX(slideX)
	}

	/*********************
	 ***** WRAP *****
	 *********************/

	// Reuse these allocations to avoid GC pressure in repeat mode
	const repeatVirtualCache: number[] = []
	const repeatElementOffsetCache = new Map<HTMLElement, number>()
	const appliedTranslate = new Map<HTMLElement, number>()

	function setTranslate(el: HTMLElement, x: number): void {
		if (appliedTranslate.get(el) === x) return
		appliedTranslate.set(el, x)
		el.style.translate = `${x}px 0`
	}

	function clearTranslations(): void {
		for (const el of appliedTranslate.keys()) el.style.translate = ''
		appliedTranslate.clear()
	}

	function onRepeat(): void {
		if (!scroller) return

		const loopWidth = getLoopWidth()
		if (loopWidth === 0) return

		if (virtualScroll.x >= end) {
			virtualScroll.x -= loopWidth
			target.x -= loopWidth
			if (!isTicking) {
				scroller.scrollTo({ left: virtualScroll.x, behavior: 'instant' })
			}
		} else if (virtualScroll.x <= securityMargin) {
			virtualScroll.x += loopWidth
			target.x += loopWidth
			if (!isTicking) {
				scroller.scrollTo({ left: virtualScroll.x, behavior: 'instant' })
			}
		}

		const scrollLeft = virtualScroll.x

		// Clear and reuse cached arrays/maps
		repeatElementOffsetCache.clear()
		repeatVirtualCache.length = snapPoints.length

		// Compute offsets for snapped elements first to produce a dense virtualSnapPoints
		for (let i = 0; i < snapElements.length; i++) {
			const el = snapElements[i]
			const basePoint = snapPoints[i] ?? 0
			const alignement = snapAlignments[i] ?? 'start'
			// snapWidths is measured during sync; reading clientWidth here would force a
			// layout on every frame, right in the middle of the translate writes below.
			const width = snapWidths[i] ?? 0
			const dx = alignement === 'start' ? 0 : alignement === 'end' ? (scrollerWidth - width) / 2 : (-scrollerWidth + width) / 2
			const raw = (scrollLeft - basePoint + dx) / loopWidth
			const k = Math.round(raw + (velocity.x >= 0 ? 0.001 : -0.001))
			const offsetX = k * loopWidth
			setTranslate(el, offsetX)
			repeatElementOffsetCache.set(el, offsetX)
			repeatVirtualCache[i] = basePoint + offsetX
		}

		// Translate non-snap slides to the nearest previous snapped slide's cycle
		let previousOffset = 0
		for (let i = 0; i < slides.length; i++) {
			const el = slides[i]
			const own = repeatElementOffsetCache.get(el)
			if (own !== undefined) {
				previousOffset = own
				continue
			}
			setTranslate(el, previousOffset)
		}

		// Replace contents of virtualSnapPoints with the dense array
		virtualSnapPoints.length = 0
		for (let i = 0; i < repeatVirtualCache.length; i++) virtualSnapPoints.push(repeatVirtualCache[i])
	}

	/******************
	 ***** Ticker *****
	 ******************/

	const FRICTION = 0.72
	const DAMPING = 0.12
	let isTicking = false

	function setIsTicking(bool: boolean): void {
		if (!scroller) return
		// Called on every pointermove past the drag threshold, so don't rewrite the attribute.
		if (bool === isTicking) return

		if (bool && !isTicking) {
			lastTick = performance.now()
			if (hasOverflow.x) target.x = scroller.scrollLeft
			if (hasOverflow.y) target.y = scroller.scrollTop

			if (!raf) {
				raf = requestAnimationFrame(tick)
			}
		} else if (!bool && raf) {
			cancelAnimationFrame(raf)
			raf = null
		}

		isTicking = bool
		snap = !bool

		scroller.setAttribute('has-snap', snap ? 'true' : 'false')
	}

	// Sub-pixel threshold below which motion is indistinguishable and the loop can stop.
	const SETTLE_EPSILON = 0.05

	let frameDelta = 0
	let lastTick = 0
	function tick(t: number): void {
		frameDelta = t - lastTick
		lastTick = t

		if (hasOverflow.x) handleAxisTick('x')
		if (hasOverflow.y) handleAxisTick('y')

		if (options?.repeat) {
			onRepeat()
		} else {
			applyRubberBanding(round(virtualScroll.x, 2))
		}

		__scrollingInternally = true
		scroller.scrollTo({
			left: virtualScroll.x,
			top: virtualScroll.y,
			behavior: 'instant' as ScrollBehavior,
		})

		// virtualScroll is what we just scrolled to, so we don't need to read scrollLeft back
		updateCurrentIndex(virtualScroll.x)

		// Stop once motion has converged, otherwise this loop runs forever
		if (isSettled()) {
			setIsTicking(false)
			return
		}

		raf = requestAnimationFrame(tick)
	}

	function isSettled(): boolean {
		if (isDragging) return false
		// Only axes that tick can converge. Checking an axis that lost its overflow would
		// keep the loop alive forever on whatever stale velocity it was left holding.
		if (hasOverflow.x && !isAxisSettled('x')) return false
		if (hasOverflow.y && !isAxisSettled('y')) return false
		return Math.abs(rubberBandOffset) < SETTLE_EPSILON
	}

	function isAxisSettled(axis: 'x' | 'y'): boolean {
		return Math.abs(velocity[axis]) < SETTLE_EPSILON && Math.abs(target[axis] - virtualScroll[axis]) < SETTLE_EPSILON
	}

	let rubberBandOffset = 0
	function applyRubberBanding(left: number): void {
		if (!scroller) return

		//TODO: add support for vertical rubber banding
		const edge = end

		let targetOffset = 0
		if (left * dir <= 0) {
			targetOffset = isDragging ? left * -0.2 : 0
		} else if (left * dir > edge * dir) {
			targetOffset = isDragging ? (left - edge) * -0.2 : 0
		}
		rubberBandOffset = damp(rubberBandOffset, targetOffset, isDragging ? 0.8 : DAMPING, frameDelta)

		if (Math.abs(rubberBandOffset) > 0.01) {
			const evt = dispatchOverscrollEvent(rubberBandOffset)
			if (evt.defaultPrevented) return
			scroller.style.transform = `translateX(${round(rubberBandOffset, 3)}px)`
			return
		}

		// Only clear once, not on every frame spent at rest
		if (rubberBandOffset !== 0) {
			scroller.style.transform = ''
			rubberBandOffset = 0
		}
	}

	function dispatchOverscrollEvent(left: number): CustomEvent<{ left: number }> {
		const overscrollEvent = new CustomEvent('overscroll', {
			bubbles: true,
			cancelable: true,
			detail: { left },
		})
		scroller?.dispatchEvent(overscrollEvent)
		return overscrollEvent
	}

	/******************************
	 ********* METHODS **************
	 ******************************/

	let __scrollingInternally = false
	let restoreScrollOverrides: (() => void) | null = null

	// Installed per init() and undone per destroy(), so the instance survives a
	// destroy/init cycle and hands back any override the element already carried.
	function installScrollOverrides(): void {
		restoreScrollOverrides?.()

		const originals = (['scrollTo', 'scrollBy'] as const).map((name) => {
			const native = scroller[name].bind(scroller)
			const had = Object.hasOwn(scroller, name)
			const previous = scroller[name]

			scroller[name] = ((optionsOrX?: ScrollToOptions | number, y?: number) => {
				const internal = __scrollingInternally === true
				if (!internal) setIsTicking(false)
				__scrollingInternally = false
				if (typeof optionsOrX === 'number') {
					native(optionsOrX, y ?? 0)
				} else {
					native(optionsOrX)
				}
			}) as typeof scroller.scrollTo

			return { name, had, previous }
		})

		restoreScrollOverrides = () => {
			for (const { name, had, previous } of originals) {
				if (had) scroller[name] = previous
				else delete (scroller as Partial<HTMLElement>)[name]
			}
			restoreScrollOverrides = null
		}
	}

	/******************************
	 ********* UTILS **************
	 ******************************/

	interface AxisOption {
		axis: 'x' | 'y'
	}

	function handleAxisPointerDown(axis: 'x' | 'y', clientPos: number): void {
		const scrollProp = axis === 'x' ? 'scrollLeft' : 'scrollTop'
		virtualScroll[axis] = scroller[scrollProp]
		target[axis] = scroller[scrollProp]
		pointerStart[axis] = clientPos
		velocity[axis] = 0
	}

	function handleAxisPointerMove(axis: 'x' | 'y', clientPos: number): void {
		const delta = pointerStart[axis] - clientPos
		target[axis] += delta
		velocity[axis] += delta
		pointerStart[axis] = clientPos
		distanceMovedSincePointerDown[axis] += Math.abs(delta)
	}

	function handleAxisTick(axis: 'x' | 'y'): void {
		velocity[axis] *= FRICTION
		if (!isDragging) {
			target[axis] += velocity[axis]
			virtualScroll[axis] = damp(virtualScroll[axis], target[axis], DAMPING, frameDelta)
		} else {
			virtualScroll[axis] = damp(virtualScroll[axis], target[axis], FRICTION, frameDelta)
		}
	}

	function project({ axis = 'x' }: AxisOption): number {
		return target[axis] + velocity[axis] / (1 - FRICTION)
	}

	function snapSelect({ axis = 'x' }: AxisOption): number {
		const restingX = project({ axis })
		const points = virtualSnapPoints.length ? virtualSnapPoints : snapPoints
		return points.reduce((prev, curr) => (Math.abs(curr - restingX) < Math.abs(prev - restingX) ? curr : prev))
	}

	function lerp(x: number, y: number, t: number): number {
		return (1 - t) * x + t * y
	}

	function damp(x: number, y: number, t: number, delta: number): number {
		return lerp(x, y, 1 - Math.exp(Math.log(1 - t) * (delta / (1000 / 60))))
	}

	function clamp(value: number, min: number, max: number): number {
		if (value < min) return min
		if (value > max) return max
		return value
	}

	function round(value: number, precision = 0): number {
		const multiplier = 10 ** precision
		return Math.round(value * multiplier) / multiplier
	}

	/******************************
	 ********* REPEAT UTILS *********
	 ******************************/

	function getLoopWidth(): number {
		return scrollerScrollWidth - scrollerWidth + gap
	}

	function getMaxScrollPosition(): number {
		return scrollerScrollWidth - scrollerWidth
	}

	function getScrollBounds(): { min: number; max: number } {
		const maxScroll = getMaxScrollPosition()
		return {
			min: Math.min(maxScroll * dir, 0),
			max: Math.max(maxScroll * dir, 0),
		}
	}

	function normalizeToCycle(point: number, reference: number): number {
		const w = getLoopWidth()
		if (w <= 0) return point
		const k = Math.round((reference - point) / w)
		return point + k * w
	}

	function animateToSlideX(slideX: number, enforceDir?: 1 | -1): void {
		if (slideX === undefined || Number.isNaN(slideX)) return

		setIsTicking(true)
		target.x = virtualScroll.x
		let distance = slideX - virtualScroll.x
		if (options?.repeat) {
			const w = getLoopWidth()
			if (w > 0) {
				// shortest path wrapping
				distance = distance - Math.round(distance / w) * w
				// optionally enforce intended direction (for prev/next)
				if (enforceDir === 1 && distance * dir <= 0) distance += w * dir
				if (enforceDir === -1 && distance * dir >= 0) distance -= w * dir
			}
		}
		const force = distance * (1 - FRICTION) * (1 / FRICTION)
		velocity.x = force
	}

	function computeRepeatSlideX(targetIndex: number, directionSign: 1 | -1): number {
		const base = snapPoints[targetIndex] ?? 0
		const candidate = normalizeToCycle(base, virtualScroll.x)
		const w = getLoopWidth()
		if (w <= 0) return candidate
		const delta = candidate - virtualScroll.x
		if (directionSign === 1 && delta * dir <= 0) return candidate + w * dir
		if (directionSign === -1 && delta * dir >= 0) return candidate - w * dir
		return candidate
	}

	/******************************
	 ********* NAVIGATION *********
	 ******************************/

	function getCurrentSnapIndex(scrollLeft?: number): number {
		const points = options?.repeat && virtualSnapPoints.length ? virtualSnapPoints : snapPoints
		if (!points.length) return 0

		const currentScroll = scrollLeft ?? scroller.scrollLeft
		let closestIndex = 0
		let closestDistance = Math.abs(points[0] - currentScroll)

		for (let i = 1; i < points.length; i++) {
			const distance = Math.abs(points[i] - currentScroll)
			if (distance < closestDistance) {
				closestDistance = distance
				closestIndex = i
			}
		}

		return closestIndex
	}

	function updateCurrentIndex(scrollLeft?: number): void {
		const newIndex = getCurrentSnapIndex(scrollLeft)
		if (currentIndex.value !== newIndex) {
			currentIndex.value = newIndex
		}
	}

	function navigate(direction: 1 | -1): void {
		if (snapElements.length <= 1) return

		const points = snapPoints
		const targetIndex = options?.repeat
			? (currentIndex.value + direction + points.length) % points.length
			: direction === 1
				? Math.min(currentIndex.value + 1, points.length - 1)
				: Math.max(currentIndex.value - 1, 0)

		if (nativeScroll) {
			const align = snapAlignments[targetIndex] ?? 'start'
			;(snapElements[targetIndex] as HTMLElement).scrollIntoView({
				behavior: 'smooth',
				block: 'nearest',
				inline: align,
			})
			return
		}

		let slideX: number | undefined
		if (options?.repeat && points.length >= 2) {
			const loopWidth = getLoopWidth()
			const base = points[targetIndex]
			const k = loopWidth > 0 ? Math.round((virtualScroll.x - base) / loopWidth) : 0
			let candidate = base + k * loopWidth
			const delta = candidate - virtualScroll.x
			if (direction === 1 && delta * dir <= 0) candidate += loopWidth * dir
			if (direction === -1 && delta * dir >= 0) candidate -= loopWidth * dir
			slideX = candidate
		} else {
			const bounds = getScrollBounds()
			slideX = clamp(points[targetIndex], bounds.min, bounds.max)
		}

		animateToSlideX(slideX, direction)
	}

	function next(): void {
		navigate(1)
	}

	function prev(): void {
		navigate(-1)
	}

	return {
		init,
		snap,
		hasOverflow,
		currentIndex: () => currentIndex.value,
		next,
		prev,
		destroy,
	}
}
