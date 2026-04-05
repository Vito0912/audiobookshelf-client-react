import type { LibraryFile, LibraryItem } from '@/types/api'

export interface ParsedSubtitleWord {
  id: string
  index: number
  cueIndex: number
  text: string
  start: number
  end: number
  speakerId: string | null
}

export interface ParsedSubtitleCue {
  id: string
  index: number
  start: number
  end: number
  text: string
  speakerId: string | null
  words: ParsedSubtitleWord[]
  wordStartIndex: number
  wordEndIndex: number
}

export interface ParsedWebVttSubtitles {
  cues: ParsedSubtitleCue[]
  words: ParsedSubtitleWord[]
  speakers: string[]
}

interface ProvisionalWord {
  text: string
  speakerId: string | null
  startTag: number | null
}

const TIMING_LINE_REGEX = /^\s*(\d{2}:\d{2}(?::\d{2})?\.\d{3})\s*-->\s*(\d{2}:\d{2}(?::\d{2})?\.\d{3})/i
const TOKEN_REGEX = /(<\/?v(?:\.[^ >]+)*(?:\s+[^>]*?)?>|<\d{2}:\d{2}(?::\d{2})?\.\d{3}>)/gi
const TIMESTAMP_TAG_REGEX = /^<(\d{2}:\d{2}(?::\d{2})?\.\d{3})>$/i
const SPEAKER_OPEN_TAG_REGEX = /^<v(?:\.[^ >]+)*(?:\s+([^>]*?))?>$/i
const SPEAKER_CLOSE_TAG_REGEX = /^<\/v>$/i
const SPEAKER_PREFIX_REGEX = /^\s*Speaker\s+([^:\n]{1,50}):\s*/i

const MIN_WORD_DURATION_SECONDS = 0.02

function parseVttTimestamp(value: string): number {
  const parts = value.split(':')
  if (parts.length < 2 || parts.length > 3) {
    return Number.NaN
  }

  const secondsPart = Number(parts[parts.length - 1])
  const minutesPart = Number(parts[parts.length - 2])
  const hoursPart = parts.length === 3 ? Number(parts[0]) : 0

  if (![secondsPart, minutesPart, hoursPart].every(Number.isFinite)) {
    return Number.NaN
  }

  return hoursPart * 3600 + minutesPart * 60 + secondsPart
}

function parseSpeakerFromOpenTag(tag: string): string | null {
  const match = tag.match(SPEAKER_OPEN_TAG_REGEX)
  if (!match) return null

  const speakerLabel = match[1]?.trim()
  if (speakerLabel) {
    return speakerLabel
  }

  const classMatch = tag.match(/^<v\.([^ >]+)(?:\s|>)/i)
  if (classMatch?.[1]) {
    return classMatch[1].replace(/\./g, ' ')
  }

  return null
}

function normalizeCueText(cueText: string): { text: string; inferredSpeaker: string | null } {
  const speakerPrefixMatch = cueText.match(SPEAKER_PREFIX_REGEX)
  if (!speakerPrefixMatch) {
    return {
      text: cueText,
      inferredSpeaker: null
    }
  }

  const speakerId = speakerPrefixMatch[1]?.trim() || null
  if (!speakerId) {
    return {
      text: cueText,
      inferredSpeaker: null
    }
  }

  return {
    text: cueText.slice(speakerPrefixMatch[0].length),
    inferredSpeaker: `Speaker ${speakerId}`
  }
}

function appendWordsFromText(segment: string, words: ProvisionalWord[], speakerId: string | null, startTag: number | null): number | null {
  const tokens = segment.match(/\S+/g) || []

  let pendingStartTag = startTag
  tokens.forEach((token) => {
    words.push({
      text: token,
      speakerId,
      startTag: pendingStartTag
    })
    pendingStartTag = null
  })

  return pendingStartTag
}

function distributeRange(starts: number[], startIndex: number, endExclusive: number, startTime: number, endTime: number) {
  const count = endExclusive - startIndex
  if (count <= 0) return

  const safeStart = Number.isFinite(startTime) ? startTime : 0
  const safeEnd = Number.isFinite(endTime) ? endTime : safeStart + 0.1 * count

  if (safeEnd <= safeStart) {
    for (let i = 0; i < count; i++) {
      starts[startIndex + i] = safeStart + i * MIN_WORD_DURATION_SECONDS
    }
    return
  }

  const step = (safeEnd - safeStart) / (count + 1)
  for (let i = 0; i < count; i++) {
    starts[startIndex + i] = safeStart + step * (i + 1)
  }
}

function assignWordTiming(words: ProvisionalWord[], cueStart: number, cueEnd: number): Array<{ text: string; speakerId: string | null; start: number; end: number }> {
  if (!words.length) {
    return []
  }

  const starts = new Array<number>(words.length).fill(Number.NaN)
  const anchors: Array<{ index: number; time: number }> = []

  words.forEach((word, index) => {
    if (Number.isFinite(word.startTag)) {
      anchors.push({
        index,
        time: Math.max(cueStart, Math.min(cueEnd, Number(word.startTag)))
      })
    }
  })

  if (!anchors.length) {
    const cueSpan = Math.max(cueEnd - cueStart, MIN_WORD_DURATION_SECONDS * words.length)
    const step = cueSpan / words.length
    for (let i = 0; i < words.length; i++) {
      starts[i] = cueStart + step * i
    }
  } else {
    const firstAnchor = anchors[0]
    distributeRange(starts, 0, firstAnchor.index, cueStart, firstAnchor.time)
    starts[firstAnchor.index] = firstAnchor.time

    for (let i = 0; i < anchors.length - 1; i++) {
      const currentAnchor = anchors[i]
      const nextAnchor = anchors[i + 1]
      starts[currentAnchor.index] = currentAnchor.time
      distributeRange(starts, currentAnchor.index + 1, nextAnchor.index, currentAnchor.time, nextAnchor.time)
      starts[nextAnchor.index] = nextAnchor.time
    }

    const lastAnchor = anchors[anchors.length - 1]
    starts[lastAnchor.index] = lastAnchor.time
    distributeRange(starts, lastAnchor.index + 1, words.length, lastAnchor.time, cueEnd)
  }

  for (let i = 1; i < starts.length; i++) {
    if (!Number.isFinite(starts[i]) || starts[i] <= starts[i - 1]) {
      starts[i] = starts[i - 1] + MIN_WORD_DURATION_SECONDS
    }
  }

  return words.map((word, index) => {
    const start = Number.isFinite(starts[index]) ? starts[index] : cueStart
    const nextStart = index < words.length - 1 && Number.isFinite(starts[index + 1]) ? starts[index + 1] : cueEnd
    const end = Math.max(start + MIN_WORD_DURATION_SECONDS, index === words.length - 1 ? cueEnd : nextStart)

    return {
      text: word.text,
      speakerId: word.speakerId,
      start,
      end: Math.max(end, start + MIN_WORD_DURATION_SECONDS)
    }
  })
}

function parseCueWords(cueTextRaw: string, cueStart: number, cueEnd: number): { words: Array<{ text: string; start: number; end: number; speakerId: string | null }>; speakerId: string | null } {
  const { text: cueText, inferredSpeaker } = normalizeCueText(cueTextRaw)

  const provisionalWords: ProvisionalWord[] = []

  let currentSpeaker: string | null = inferredSpeaker
  let pendingStartTag: number | null = null
  let lastIndex = 0

  const matches = cueText.matchAll(TOKEN_REGEX)
  for (const match of matches) {
    const token = match[0]
    const tokenIndex = match.index || 0

    const textBeforeToken = cueText.slice(lastIndex, tokenIndex)
    pendingStartTag = appendWordsFromText(textBeforeToken, provisionalWords, currentSpeaker, pendingStartTag)

    const timestampMatch = token.match(TIMESTAMP_TAG_REGEX)
    if (timestampMatch) {
      const parsedTime = parseVttTimestamp(timestampMatch[1])
      pendingStartTag = Number.isFinite(parsedTime) ? parsedTime : null
      lastIndex = tokenIndex + token.length
      continue
    }

    if (SPEAKER_CLOSE_TAG_REGEX.test(token)) {
      currentSpeaker = inferredSpeaker
      lastIndex = tokenIndex + token.length
      continue
    }

    const parsedSpeaker = parseSpeakerFromOpenTag(token)
    if (parsedSpeaker) {
      currentSpeaker = parsedSpeaker
    }

    lastIndex = tokenIndex + token.length
  }

  pendingStartTag = appendWordsFromText(cueText.slice(lastIndex), provisionalWords, currentSpeaker, pendingStartTag)

  const timedWords = assignWordTiming(provisionalWords, cueStart, cueEnd)

  const firstSpeakerWithValue = timedWords.find((word) => !!word.speakerId)?.speakerId || inferredSpeaker || null

  return {
    words: timedWords,
    speakerId: firstSpeakerWithValue
  }
}

export function parseWebVtt(content: string): ParsedWebVttSubtitles {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')

  const cues: ParsedSubtitleCue[] = []
  const words: ParsedSubtitleWord[] = []
  const speakers = new Set<string>()

  let lineIndex = 0

  if (lines[lineIndex]?.startsWith('WEBVTT')) {
    lineIndex += 1
  }

  while (lineIndex < lines.length) {
    if (!lines[lineIndex]?.trim()) {
      lineIndex += 1
      continue
    }

    if (lines[lineIndex].startsWith('NOTE')) {
      while (lineIndex < lines.length && lines[lineIndex].trim()) {
        lineIndex += 1
      }
      continue
    }

    let cueIdentifier: string | null = null
    let timingLine = lines[lineIndex] || ''

    if (!timingLine.includes('-->')) {
      cueIdentifier = timingLine.trim() || null
      lineIndex += 1
      timingLine = lines[lineIndex] || ''
    }

    const timingMatch = timingLine.match(TIMING_LINE_REGEX)
    if (!timingMatch) {
      lineIndex += 1
      continue
    }

    const cueStart = parseVttTimestamp(timingMatch[1])
    const cueEnd = parseVttTimestamp(timingMatch[2])

    if (!Number.isFinite(cueStart) || !Number.isFinite(cueEnd) || cueEnd <= cueStart) {
      lineIndex += 1
      continue
    }

    lineIndex += 1

    const cueTextLines: string[] = []
    while (lineIndex < lines.length && lines[lineIndex].trim()) {
      cueTextLines.push(lines[lineIndex])
      lineIndex += 1
    }

    const cueTextRaw = cueTextLines.join(' ').replace(/\s+/g, ' ').trim()
    if (!cueTextRaw) {
      continue
    }

    const cueWordData = parseCueWords(cueTextRaw, cueStart, cueEnd)
    if (!cueWordData.words.length) {
      continue
    }

    const cueIndex = cues.length
    const wordStartIndex = words.length

    const cueWords: ParsedSubtitleWord[] = cueWordData.words.map((word, indexInCue) => {
      const globalIndex = wordStartIndex + indexInCue
      const safeStart = Math.max(cueStart, Math.min(cueEnd, word.start))
      const safeEnd = Math.max(safeStart + MIN_WORD_DURATION_SECONDS, Math.min(cueEnd, word.end))
      const speakerId = word.speakerId?.trim() || cueWordData.speakerId || null

      if (speakerId) {
        speakers.add(speakerId)
      }

      return {
        id: `${cueIndex}-${globalIndex}`,
        index: globalIndex,
        cueIndex,
        text: word.text,
        start: safeStart,
        end: safeEnd,
        speakerId
      }
    })

    words.push(...cueWords)

    cues.push({
      id: cueIdentifier || `cue-${cueIndex}`,
      index: cueIndex,
      start: cueStart,
      end: cueEnd,
      text: cueWords.map((word) => word.text).join(' '),
      speakerId: cueWordData.speakerId,
      words: cueWords,
      wordStartIndex,
      wordEndIndex: words.length - 1
    })
  }

  return {
    cues,
    words,
    speakers: Array.from(speakers)
  }
}

export function selectPreferredSubtitleFile(libraryItem: LibraryItem | null): LibraryFile | null {
  const files = (libraryItem?.libraryFiles || []).filter((libraryFile) => {
    const ext = libraryFile.metadata?.ext?.toLowerCase() || ''
    const filename = libraryFile.metadata?.filename?.toLowerCase() || ''
    return ext === '.vtt' || filename.endsWith('.vtt')
  })

  if (!files.length) {
    return null
  }

  const sortedFiles = [...files].sort((a, b) => {
    const aUpdatedAt = a.updatedAt || 0
    const bUpdatedAt = b.updatedAt || 0

    if (aUpdatedAt !== bUpdatedAt) {
      return bUpdatedAt - aUpdatedAt
    }

    const aName = a.metadata?.filename?.toLowerCase() || ''
    const bName = b.metadata?.filename?.toLowerCase() || ''

    return aName.localeCompare(bName)
  })

  return sortedFiles[0]
}
