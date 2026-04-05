'use client'

import { useTypeSafeTranslations } from '@/hooks/useTypeSafeTranslations'
import type { UsePlayerSubtitlesReturn } from '@/hooks/usePlayerSubtitles'
import type { PlayerSettings } from '@/hooks/usePlayerSettings'
import { mergeClasses } from '@/lib/merge-classes'
import type { ParsedSubtitleWord } from '@/lib/player/subtitles'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react'

interface FloatingSubtitlesProps {
  settings: PlayerSettings
  subtitles: UsePlayerSubtitlesReturn
  className?: string
}

interface OverlayPosition {
  x: number
  y: number
}

interface DragState {
  pointerId: number
  startClientX: number
  startClientY: number
  startX: number
  startY: number
  minX: number
  maxX: number
  minY: number
  maxY: number
}

interface OverlaySize {
  width: number
  height: number
}

interface ResizeState {
  pointerId: number
  startClientX: number
  startClientY: number
  startWidth: number
  startHeight: number
  startPanelLeft: number
  startPanelTop: number
}

const POSITION_STORAGE_KEY = 'absPlayerFloatingSubtitlePosition'
const SIZE_STORAGE_KEY = 'absPlayerFloatingSubtitleSize'
const DEFAULT_POSITION: OverlayPosition = { x: 0, y: 0 }
const DEFAULT_SIZE: OverlaySize = { width: 400, height: 50 }

const MIN_WIDTH = 240
const MIN_HEIGHT = 50
const VIEWPORT_MARGIN = 8
const DRAG_AREA_HEIGHT = 14
const RESIZE_CORNER_SIZE = 16
const SCROLL_DEAD_ZONE_PX = 2

function clampValue(value: number, min: number, max: number): number {
  if (min > max) {
    return value
  }

  return Math.max(min, Math.min(max, value))
}

function splitWordsBySpeaker(words: ParsedSubtitleWord[]) {
  if (!words.length) {
    return []
  }

  const groups: Array<{ speakerId: string | null; words: ParsedSubtitleWord[] }> = []

  for (const word of words) {
    const previousGroup = groups[groups.length - 1]
    if (previousGroup && previousGroup.speakerId === word.speakerId) {
      previousGroup.words.push(word)
      continue
    }

    groups.push({
      speakerId: word.speakerId,
      words: [word]
    })
  }

  return groups
}

export default function FloatingSubtitles({ settings, subtitles, className = '' }: FloatingSubtitlesProps) {
  const t = useTypeSafeTranslations()

  const continuousContainerRef = useRef<HTMLDivElement | null>(null)
  const lineModeContainerRef = useRef<HTMLDivElement | null>(null)
  const activeWordRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const dragStateRef = useRef<DragState | null>(null)
  const resizeStateRef = useRef<ResizeState | null>(null)

  const [overlayPosition, setOverlayPosition] = useState<OverlayPosition>(DEFAULT_POSITION)
  const [overlaySize, setOverlaySize] = useState<OverlaySize>(DEFAULT_SIZE)
  const [isDragging, setIsDragging] = useState(false)
  const [isResizing, setIsResizing] = useState(false)

  const { status, errorMessage, cues, words, activeCueIndex, activeWordIndex, focusWordIndex, visibleParagraphs, speakerColors } = subtitles

  const isContinuousMode = settings.subtitleContinuousReaderMode

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    try {
      const stored = localStorage.getItem(POSITION_STORAGE_KEY)
      if (!stored) {
        return
      }

      const parsed = JSON.parse(stored) as Partial<OverlayPosition>
      if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') {
        return
      }

      setOverlayPosition({
        x: parsed.x,
        y: parsed.y
      })
    } catch {
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(overlayPosition))
  }, [overlayPosition])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    try {
      const stored = localStorage.getItem(SIZE_STORAGE_KEY)
      if (!stored) {
        return
      }

      const parsed = JSON.parse(stored) as Partial<OverlaySize>
      if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') {
        return
      }

      setOverlaySize({
        width: Math.max(MIN_WIDTH, Math.round(parsed.width)),
        height: Math.max(MIN_HEIGHT, Math.round(parsed.height))
      })
    } catch {
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify(overlaySize))
  }, [overlaySize])

  const displayedCue = useMemo(() => {
    if (!cues.length) {
      return null
    }

    if (activeCueIndex >= 0) {
      return cues[activeCueIndex]
    }

    if (focusWordIndex >= 0) {
      const focusWord = words[focusWordIndex]
      if (focusWord && focusWord.cueIndex >= 0) {
        return cues[focusWord.cueIndex] || null
      }
    }

    return cues[0]
  }, [cues, activeCueIndex, focusWordIndex, words])

  useEffect(() => {
    if (activeWordIndex < 0) {
      return
    }

    const container = isContinuousMode ? continuousContainerRef.current : lineModeContainerRef.current
    const wordElement = activeWordRef.current
    if (!container || !wordElement) {
      return
    }

    const containerRect = container.getBoundingClientRect()
    const wordRect = wordElement.getBoundingClientRect()
    const nextScrollTop = container.scrollTop + (wordRect.top - containerRect.top) - container.clientHeight / 2 + wordRect.height / 2

    if (Math.abs(nextScrollTop - container.scrollTop) <= SCROLL_DEAD_ZONE_PX) {
      return
    }

    container.scrollTo({ top: Math.max(0, nextScrollTop), behavior: 'smooth' })
  }, [isContinuousMode, activeWordIndex, visibleParagraphs, displayedCue?.id])

  if (!settings.subtitleEnabled || status === 'idle') {
    return null
  }

  const handleDragStart = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || isResizing) {
      return
    }

    event.preventDefault()

    const panel = panelRef.current
    if (!panel) {
      return
    }

    const panelRect = panel.getBoundingClientRect()
    const baseLeft = panelRect.left - overlayPosition.x
    const baseTop = panelRect.top - overlayPosition.y

    const minX = VIEWPORT_MARGIN - baseLeft
    const maxX = window.innerWidth - VIEWPORT_MARGIN - baseLeft - panelRect.width
    const minY = VIEWPORT_MARGIN - baseTop
    const maxY = window.innerHeight - VIEWPORT_MARGIN - baseTop - panelRect.height

    event.currentTarget.setPointerCapture(event.pointerId)

    dragStateRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: overlayPosition.x,
      startY: overlayPosition.y,
      minX,
      maxX,
      minY,
      maxY
    }

    setIsDragging(true)
  }

  const handleDragMove = (event: PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return
    }

    const deltaX = event.clientX - dragState.startClientX
    const deltaY = event.clientY - dragState.startClientY

    setOverlayPosition({
      x: clampValue(Math.round(dragState.startX + deltaX), dragState.minX, dragState.maxX),
      y: clampValue(Math.round(dragState.startY + deltaY), dragState.minY, dragState.maxY)
    })
  }

  const handleDragEnd = (event: PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    dragStateRef.current = null
    setIsDragging(false)
  }

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !settings.subtitleFixedSizeMode || isDragging) {
      return
    }

    event.preventDefault()

    const panel = panelRef.current
    if (!panel) {
      return
    }

    const panelRect = panel.getBoundingClientRect()

    event.currentTarget.setPointerCapture(event.pointerId)

    resizeStateRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startWidth: overlaySize.width,
      startHeight: overlaySize.height,
      startPanelLeft: panelRect.left,
      startPanelTop: panelRect.top
    }

    setIsResizing(true)
  }

  const handleResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current
    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return
    }

    const deltaX = event.clientX - resizeState.startClientX
    const deltaY = event.clientY - resizeState.startClientY

    const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - VIEWPORT_MARGIN - resizeState.startPanelLeft)
    const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - VIEWPORT_MARGIN - resizeState.startPanelTop)

    const nextWidth = resizeState.startWidth + deltaX
    const nextHeight = resizeState.startHeight - deltaY

    const clampedWidth = clampValue(Math.round(nextWidth), MIN_WIDTH, maxWidth)
    const clampedHeight = clampValue(Math.round(nextHeight), MIN_HEIGHT, maxHeight)
    setOverlaySize({
      width: clampedWidth,
      height: clampedHeight
    })
  }

  const handleResizeEnd = (event: PointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current
    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    resizeStateRef.current = null
    setIsResizing(false)
  }

  const dragAreaStyle: CSSProperties = {
    top: 0,
    left: 0,
    right: settings.subtitleFixedSizeMode ? RESIZE_CORNER_SIZE : 0,
    height: DRAG_AREA_HEIGHT
  }

  const dragArea = (
    <div
      aria-label="Move subtitles"
      className={mergeClasses('absolute z-30', isDragging ? 'cursor-grabbing' : 'cursor-grab')}
      style={dragAreaStyle}
      onPointerDown={handleDragStart}
      onPointerMove={handleDragMove}
      onPointerUp={handleDragEnd}
      onPointerCancel={handleDragEnd}
    />
  )

  const resizeCornerHandle = settings.subtitleFixedSizeMode ? (
    <div
      className="absolute top-0 right-0 z-40"
      style={{ width: RESIZE_CORNER_SIZE, height: RESIZE_CORNER_SIZE, cursor: 'nesw-resize' }}
      onPointerDown={startResize}
      onPointerMove={handleResizeMove}
      onPointerUp={handleResizeEnd}
      onPointerCancel={handleResizeEnd}
    />
  ) : null

  const panelStyle: CSSProperties = {
    transform: `translate(${overlayPosition.x}px, ${overlayPosition.y}px)`
  }

  if (settings.subtitleFixedSizeMode) {
    panelStyle.width = `${overlaySize.width}px`
    panelStyle.height = `${overlaySize.height}px`
  }

  const renderWord = (word: ParsedSubtitleWord, indexInMap: number, isLastWord: boolean) => {
    const isCurrentWord = activeWordIndex >= 0 && word.index === activeWordIndex
    const shouldUseFilledHighlight = isCurrentWord && settings.subtitleWordHighlight
    const speakerColor = settings.subtitleSpeakerColors && word.speakerId ? speakerColors[word.speakerId] : undefined

    const wordStyle = speakerColor ? { color: speakerColor } : undefined

    return (
      <span key={`${word.id}-${indexInMap}`} className="inline">
        <span
          ref={
            isCurrentWord
              ? (element) => {
                  activeWordRef.current = element
                }
              : undefined
          }
          className={mergeClasses('inline rounded-[0.26rem] py-[1px]', shouldUseFilledHighlight ? 'bg-white/24 shadow-[0_0_0_1px_rgba(255,255,255,0.28)]' : '', !speakerColor ? 'text-white/90' : '')}
          style={wordStyle}
        >
          {word.text}
        </span>
        {!isLastWord ? ' ' : null}
      </span>
    )
  }

  if (status === 'loading') {
    return (
      <div className={mergeClasses('pointer-events-none flex justify-center', className)}>
        <div className="pointer-events-auto rounded-xl border border-white/20 bg-black/40 px-4 py-2 text-sm text-white/90 shadow-xl backdrop-blur-md">{t('MessagePlayerSubtitlesLoading')}</div>
      </div>
    )
  }

  if (status === 'missing') {
    return (
      <div className={mergeClasses('pointer-events-none flex justify-center', className)}>
        <div className="pointer-events-auto rounded-xl border border-white/20 bg-black/40 px-4 py-2 text-sm text-white/85 shadow-xl backdrop-blur-md">{t('MessagePlayerSubtitlesMissing')}</div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className={mergeClasses('pointer-events-none flex justify-center', className)}>
        <div className="pointer-events-auto rounded-xl border border-red-300/30 bg-black/40 px-4 py-2 text-sm text-red-100 shadow-xl backdrop-blur-md">
          {t('MessagePlayerSubtitlesError')}
          {errorMessage ? ` (${errorMessage})` : ''}
        </div>
      </div>
    )
  }

  if (!words.length) {
    return null
  }

  if (!isContinuousMode) {
    const cueWords = displayedCue?.words || []
    if (!cueWords.length) {
      return null
    }

    const speakerGroups = splitWordsBySpeaker(cueWords)

    return (
      <div className={mergeClasses('pointer-events-none flex justify-center', className)}>
        <div
          ref={panelRef}
          className={mergeClasses(
            'pointer-events-auto relative rounded-2xl border border-white/20 bg-black/40 px-5 py-3 text-center text-[1rem] leading-7 text-white shadow-xl backdrop-blur-md',
            settings.subtitleFixedSizeMode ? '' : 'max-w-[min(90vw,900px)]',
            isDragging || isResizing ? 'select-none' : ''
          )}
          style={panelStyle}
        >
          {dragArea}
          {resizeCornerHandle}

          <div
            ref={lineModeContainerRef}
            className={mergeClasses('overflow-hidden', settings.subtitleFixedSizeMode ? 'h-full' : 'max-h-[5.25rem]')}
            onWheel={(event) => event.preventDefault()}
          >
            <div className="flex justify-center">
              <div className="max-w-full text-pretty whitespace-normal text-center">
                {speakerGroups.map((group, groupIndex) => {
                  return (
                    <span key={`${group.speakerId || 'none'}-${groupIndex}`}>
                      {group.words.map((word, wordIndex) => renderWord(word, wordIndex, wordIndex === group.words.length - 1 && groupIndex === speakerGroups.length - 1))}
                      {groupIndex < speakerGroups.length - 1 && <span className="mx-2 text-white/60">|</span>}
                    </span>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={mergeClasses('pointer-events-none flex justify-center', className)}>
      <div
        ref={panelRef}
        className={mergeClasses(
          'pointer-events-auto relative rounded-2xl border border-white/20 bg-black/60 p-1 text-white shadow-2xl backdrop-blur-md',
          settings.subtitleFixedSizeMode ? '' : 'w-[min(92vw,980px)]',
          isDragging || isResizing ? 'select-none' : ''
        )}
        style={panelStyle}
      >
        {dragArea}
        {resizeCornerHandle}

        <div
          ref={continuousContainerRef}
          className={mergeClasses('overflow-hidden px-1 py-1 leading-8 md:text-[1.05rem]', settings.subtitleFixedSizeMode ? 'h-full' : 'max-h-[38vh]')}
          onWheel={(event) => event.preventDefault()}
        >
          <div className="space-y-4">
            {visibleParagraphs.map((paragraph) => {
              const paragraphWords = words.slice(paragraph.wordStartIndex, paragraph.wordEndIndex + 1)

              return (
                <p key={paragraph.id} className="rounded-lg bg-transparent px-2 py-1">
                  {paragraphWords.map((word, wordIndex) => renderWord(word, wordIndex, wordIndex === paragraphWords.length - 1))}
                </p>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
