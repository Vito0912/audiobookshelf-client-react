import { useEffect, useMemo, useRef, useState } from 'react'

import type { PlayerSettings } from '@/hooks/usePlayerSettings'
import { parseWebVtt, selectPreferredSubtitleFile, type ParsedSubtitleCue, type ParsedSubtitleWord, type ParsedWebVttSubtitles } from '@/lib/player/subtitles'
import type { LibraryItem } from '@/types/api'
import { PlayerState } from '@/types/api'

const LONG_PAUSE_PARAGRAPH_GAP_SECONDS = 1.2
const WORD_STICKY_GAP_SECONDS = 0.35
const CONTINUOUS_PARAGRAPH_WINDOW_BEFORE = 3
const CONTINUOUS_PARAGRAPH_WINDOW_AFTER = 3
const PARAGRAPH_WORD_SOFT_LIMIT = 200
const PARAGRAPH_WORD_HARD_LIMIT = 300
const PARAGRAPH_WORD_MIN_LIMIT = 0

const SPEAKER_COLOR_PALETTE = ['#93c5fd', '#f9a8d4', '#fcd34d', '#86efac', '#a5b4fc', '#fca5a5', '#67e8f9', '#d8b4fe', '#fda4af', '#bef264']

type SubtitleStatus = 'idle' | 'loading' | 'missing' | 'ready' | 'error'

export interface SubtitleParagraph {
  id: string
  index: number
  start: number
  end: number
  wordStartIndex: number
  wordEndIndex: number
}

interface ParagraphBuildResult {
  paragraphs: SubtitleParagraph[]
  wordToParagraphIndex: number[]
}

interface UsePlayerSubtitlesParams {
  libraryItem: LibraryItem | null
  currentTime: number
  duration: number
  playbackRate: number
  playerState: PlayerState
  settings: PlayerSettings
}

export interface UsePlayerSubtitlesReturn {
  status: SubtitleStatus
  errorMessage: string | null
  subtitleFileName: string | null
  cues: ParsedSubtitleCue[]
  words: ParsedSubtitleWord[]
  activeCueIndex: number
  activeWordIndex: number
  focusWordIndex: number
  activeParagraphIndex: number
  paragraphs: SubtitleParagraph[]
  visibleParagraphs: SubtitleParagraph[]
  speakerColors: Record<string, string>
  hasSpeakerData: boolean
}

function findIndexAtOrBeforeTime(words: ParsedSubtitleWord[], time: number): number {
  if (!words.length) return -1

  let low = 0
  let high = words.length - 1
  let result = -1

  while (low <= high) {
    const mid = low + Math.floor((high - low) / 2)
    if (words[mid].start <= time) {
      result = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return result
}

function findActiveWordIndexAtTime(words: ParsedSubtitleWord[], time: number): number {
  if (!words.length) return -1

  const nearestAtOrBefore = findIndexAtOrBeforeTime(words, time)
  if (nearestAtOrBefore < 0) {
    return -1
  }

  const currentWord = words[nearestAtOrBefore]
  if (time >= currentWord.start && time <= currentWord.end) {
    return nearestAtOrBefore
  }

  if (time > currentWord.end) {
    const nextWord = words[nearestAtOrBefore + 1]
    if (nextWord && time < nextWord.start) {
      const gap = nextWord.start - currentWord.end
      const timeSinceCurrent = time - currentWord.end
      if (gap <= WORD_STICKY_GAP_SECONDS && timeSinceCurrent <= WORD_STICKY_GAP_SECONDS) {
        return nearestAtOrBefore
      }
      return -1
    }

    const timeSinceCurrent = time - currentWord.end
    if (!nextWord && timeSinceCurrent <= WORD_STICKY_GAP_SECONDS) {
      return nearestAtOrBefore
    }

    return -1
  }

  return -1
}

function findCueIndexAtTime(cues: ParsedSubtitleCue[], time: number): number {
  if (!cues.length) return -1

  let low = 0
  let high = cues.length - 1

  while (low <= high) {
    const mid = low + Math.floor((high - low) / 2)
    const cue = cues[mid]

    if (time < cue.start) {
      high = mid - 1
      continue
    }

    if (time > cue.end) {
      low = mid + 1
      continue
    }

    return mid
  }

  return -1
}

function isSentenceBoundaryWord(text: string): boolean {
  return /[.!?]["')\]]*$/.test(text.trim())
}

function buildParagraphs(words: ParsedSubtitleWord[], pauseThresholdSeconds: number, maxWordsPerParagraph: number): ParagraphBuildResult {
  if (!words.length) {
    return {
      paragraphs: [],
      wordToParagraphIndex: []
    }
  }

  const paragraphs: SubtitleParagraph[] = []
  const wordToParagraphIndex = new Array<number>(words.length)

  let paragraphStartIndex = 0
  let paragraphStartTime = words[0].start

  const finalizeParagraph = (wordEndIndex: number) => {
    if (wordEndIndex < paragraphStartIndex) {
      return
    }

    const paragraphIndex = paragraphs.length
    paragraphs.push({
      id: `paragraph-${paragraphIndex}`,
      index: paragraphIndex,
      start: paragraphStartTime,
      end: words[wordEndIndex].end,
      wordStartIndex: paragraphStartIndex,
      wordEndIndex
    })

    for (let wordIndex = paragraphStartIndex; wordIndex <= wordEndIndex; wordIndex++) {
      wordToParagraphIndex[wordIndex] = paragraphIndex
    }

    paragraphStartIndex = wordEndIndex + 1
    if (paragraphStartIndex < words.length) {
      paragraphStartTime = words[paragraphStartIndex].start
    }
  }

  for (let i = 1; i < words.length; i++) {
    const previousWord = words[i - 1]
    const currentWord = words[i]

    const pause = currentWord.start - previousWord.end
    if (pause > pauseThresholdSeconds && i - paragraphStartIndex >= PARAGRAPH_WORD_MIN_LIMIT) {
      finalizeParagraph(i - 1)
      continue
    }

    const wordsInParagraph = i - paragraphStartIndex + 1
    const hasReachedSoftLimit = wordsInParagraph > maxWordsPerParagraph
    const hasReachedHardLimit = wordsInParagraph >= PARAGRAPH_WORD_HARD_LIMIT

    if (hasReachedSoftLimit && isSentenceBoundaryWord(currentWord.text)) {
      finalizeParagraph(i)
      continue
    }

    if (hasReachedHardLimit) {
      finalizeParagraph(i)
      continue
    }
  }

  if (paragraphStartIndex < words.length) {
    finalizeParagraph(words.length - 1)
  }

  return {
    paragraphs,
    wordToParagraphIndex
  }
}

export function usePlayerSubtitles({ libraryItem, currentTime, duration, playbackRate, playerState, settings }: UsePlayerSubtitlesParams): UsePlayerSubtitlesReturn {
  const [status, setStatus] = useState<SubtitleStatus>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [subtitleData, setSubtitleData] = useState<ParsedWebVttSubtitles | null>(null)
  const [activeCueIndex, setActiveCueIndex] = useState(-1)
  const [activeWordIndex, setActiveWordIndex] = useState(-1)
  const [focusWordIndex, setFocusWordIndex] = useState(-1)

  const parsedCacheRef = useRef<Record<string, ParsedWebVttSubtitles>>({})

  const subtitleFile = useMemo(() => selectPreferredSubtitleFile(libraryItem), [libraryItem])

  const libraryItemId = libraryItem?.id || null
  const libraryItemUpdatedAt = libraryItem?.updatedAt || 0
  const subtitleFileIno = subtitleFile?.ino || null
  const subtitleFileUpdatedAt = subtitleFile?.updatedAt || 0
  const subtitleFileName = subtitleFile?.metadata?.filename || null
  const subtitleCacheKey = libraryItemId && subtitleFileIno ? `${libraryItemId}:${subtitleFileIno}:${subtitleFileUpdatedAt}` : null

  useEffect(() => {
    if (!libraryItemId) {
      setStatus('idle')
      setErrorMessage(null)
      setSubtitleData(null)
      return
    }

    if (!subtitleFileIno) {
      setStatus('missing')
      setErrorMessage(null)
      setSubtitleData(null)
      return
    }

    if (!subtitleCacheKey) {
      setStatus('missing')
      setErrorMessage(null)
      setSubtitleData(null)
      return
    }

    if (parsedCacheRef.current[subtitleCacheKey]) {
      setSubtitleData(parsedCacheRef.current[subtitleCacheKey])
      setStatus('ready')
      setErrorMessage(null)
      return
    }

    const abortController = new AbortController()

    const load = async () => {
      setStatus('loading')
      setErrorMessage(null)

      try {
        const cacheVersion = subtitleFileUpdatedAt || libraryItemUpdatedAt || 0
        const response = await fetch(`/internal-api/items/${libraryItemId}/file/${subtitleFileIno}?v=${cacheVersion}`, {
          signal: abortController.signal,
          cache: 'no-store'
        })

        if (response.status === 404) {
          setStatus('missing')
          setSubtitleData(null)
          return
        }

        if (!response.ok) {
          throw new Error(`Subtitle request failed with status ${response.status}`)
        }

        const subtitleText = await response.text()
        const parsed = parseWebVtt(subtitleText)

        if (!parsed.words.length || !parsed.cues.length) {
          setStatus('missing')
          setSubtitleData(null)
          return
        }

        parsedCacheRef.current[subtitleCacheKey] = parsed
        setSubtitleData(parsed)
        setStatus('ready')
      } catch (error) {
        if (abortController.signal.aborted) {
          return
        }

        setStatus('error')
        setSubtitleData(null)
        if (error instanceof Error) {
          setErrorMessage(error.message)
        } else {
          setErrorMessage('Unknown subtitle loading error')
        }
      }
    }

    void load()

    return () => {
      abortController.abort()
    }
  }, [libraryItemId, libraryItemUpdatedAt, subtitleFileIno, subtitleFileUpdatedAt, subtitleCacheKey])

  const subtitleDataRef = useRef<ParsedWebVttSubtitles | null>(subtitleData)
  subtitleDataRef.current = subtitleData

  const currentTimeRef = useRef(currentTime)
  const playbackRateRef = useRef(playbackRate)
  const playerStateRef = useRef(playerState)

  useEffect(() => {
    currentTimeRef.current = currentTime
  }, [currentTime])

  useEffect(() => {
    playbackRateRef.current = playbackRate
  }, [playbackRate])

  useEffect(() => {
    playerStateRef.current = playerState
  }, [playerState])

  const clockAnchorRef = useRef({
    wallClockTime: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    mediaTime: currentTime
  })

  useEffect(() => {
    clockAnchorRef.current = {
      wallClockTime: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      mediaTime: currentTime
    }
  }, [currentTime])

  useEffect(() => {
    clockAnchorRef.current = {
      wallClockTime: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      mediaTime: currentTimeRef.current
    }
  }, [playerState, playbackRate])

  useEffect(() => {
    if (status !== 'ready' || !subtitleData?.words.length) {
      setActiveCueIndex(-1)
      setActiveWordIndex(-1)
      setFocusWordIndex(-1)
      return
    }

    let animationFrameId = 0

    const update = (now: number) => {
      const parsed = subtitleDataRef.current
      if (!parsed) {
        animationFrameId = requestAnimationFrame(update)
        return
      }

      const anchor = clockAnchorRef.current
      const state = playerStateRef.current
      const rate = playbackRateRef.current

      let estimatedTime = anchor.mediaTime
      if (state === PlayerState.PLAYING) {
        estimatedTime = anchor.mediaTime + ((now - anchor.wallClockTime) / 1000) * rate
      } else {
        estimatedTime = currentTimeRef.current
      }

      if (Number.isFinite(duration) && duration > 0) {
        estimatedTime = Math.max(0, Math.min(duration, estimatedTime))
      }

      const nextCueIndex = findCueIndexAtTime(parsed.cues, estimatedTime)
      const nextActiveWordIndex = findActiveWordIndexAtTime(parsed.words, estimatedTime)
      const rawFocusWordIndex = findIndexAtOrBeforeTime(parsed.words, estimatedTime)
      const nextFocusWordIndex = rawFocusWordIndex < 0 ? 0 : rawFocusWordIndex

      setActiveCueIndex((previousValue) => (previousValue === nextCueIndex ? previousValue : nextCueIndex))
      setActiveWordIndex((previousValue) => (previousValue === nextActiveWordIndex ? previousValue : nextActiveWordIndex))
      setFocusWordIndex((previousValue) => (previousValue === nextFocusWordIndex ? previousValue : nextFocusWordIndex))

      animationFrameId = requestAnimationFrame(update)
    }

    animationFrameId = requestAnimationFrame(update)

    return () => {
      cancelAnimationFrame(animationFrameId)
    }
  }, [status, subtitleData, duration])

  const paragraphData = useMemo(() => {
    if (!subtitleData?.words.length) {
      return {
        paragraphs: [],
        wordToParagraphIndex: []
      }
    }

    return buildParagraphs(subtitleData.words, LONG_PAUSE_PARAGRAPH_GAP_SECONDS, PARAGRAPH_WORD_SOFT_LIMIT)
  }, [subtitleData])

  const paragraphAnchorWordIndex = activeWordIndex >= 0 ? activeWordIndex : focusWordIndex
  const activeParagraphIndex = paragraphAnchorWordIndex >= 0 ? (paragraphData.wordToParagraphIndex[paragraphAnchorWordIndex] ?? -1) : -1

  const visibleParagraphs = useMemo(() => {
    if (!paragraphData.paragraphs.length) {
      return []
    }

    if (!settings.subtitleContinuousReaderMode || activeParagraphIndex < 0) {
      return paragraphData.paragraphs.slice(
        0,
        Math.min(paragraphData.paragraphs.length, CONTINUOUS_PARAGRAPH_WINDOW_BEFORE + CONTINUOUS_PARAGRAPH_WINDOW_AFTER + 1)
      )
    }

    const startIndex = Math.max(0, activeParagraphIndex - CONTINUOUS_PARAGRAPH_WINDOW_BEFORE)
    const endIndex = Math.min(paragraphData.paragraphs.length, activeParagraphIndex + CONTINUOUS_PARAGRAPH_WINDOW_AFTER + 1)

    return paragraphData.paragraphs.slice(startIndex, endIndex)
  }, [paragraphData.paragraphs, activeParagraphIndex, settings.subtitleContinuousReaderMode])

  const speakerColors = useMemo(() => {
    const colors: Record<string, string> = {}
    if (!subtitleData?.speakers?.length) {
      return colors
    }

    subtitleData.speakers.forEach((speakerId, index) => {
      colors[speakerId] = SPEAKER_COLOR_PALETTE[index % SPEAKER_COLOR_PALETTE.length]
    })

    return colors
  }, [subtitleData?.speakers])

  return {
    status,
    errorMessage,
    subtitleFileName,
    cues: subtitleData?.cues || [],
    words: subtitleData?.words || [],
    activeCueIndex,
    activeWordIndex,
    focusWordIndex,
    activeParagraphIndex,
    paragraphs: paragraphData.paragraphs,
    visibleParagraphs,
    speakerColors,
    hasSpeakerData: !!subtitleData?.speakers?.length
  }
}
