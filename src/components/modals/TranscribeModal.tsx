'use client'

import { startItemTranscriptionAction } from '@/app/actions/mediaActions'
import Modal from '@/components/modals/Modal'
import Btn from '@/components/ui/Btn'
import Checkbox from '@/components/ui/Checkbox'
import Dropdown, { DropdownItem } from '@/components/ui/Dropdown'
import TextInput from '@/components/ui/TextInput'
import { useGlobalToast } from '@/contexts/ToastContext'
import { useTypeSafeTranslations } from '@/hooks/useTypeSafeTranslations'
import { useEffect, useMemo, useState, useTransition } from 'react'

interface TranscribeModalProps {
  isOpen: boolean
  onClose: () => void
  libraryItemId: string
  itemTitle: string
  onSubmitted?: () => void
}

const languageOptions: DropdownItem[] = [
  { text: 'English (en)', value: 'en' },
  { text: 'German (de)', value: 'de' }
]

export default function TranscribeModal({ isOpen, onClose, libraryItemId, itemTitle, onSubmitted }: TranscribeModalProps) {
  const t = useTypeSafeTranslations()
  const { showToast } = useGlobalToast()
  const [isPending, startTransition] = useTransition()

  const [apiKey, setApiKey] = useState('')
  const [languageCode, setLanguageCode] = useState<'en' | 'de'>('en')
  const [diarize, setDiarize] = useState(false)
  const [tagAudioEvents, setTagAudioEvents] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    setApiKey('')
    setLanguageCode('en')
    setDiarize(false)
    setTagAudioEvents(false)
  }, [isOpen])

  const outerContent = useMemo(
    () => (
      <div className="absolute start-0 top-0 p-4">
        <p className="max-w-[calc(100vw-4rem)] truncate text-xl font-semibold text-white" title={itemTitle}>
          {itemTitle}
        </p>
      </div>
    ),
    [itemTitle]
  )

  const handleSubmit = () => {
    if (!apiKey.trim()) {
      showToast('An API key is required.', { type: 'error' })
      return
    }

    startTransition(async () => {
      try {
        await startItemTranscriptionAction(libraryItemId, {
          apiKey: apiKey.trim(),
          languageCode,
          diarize,
          tagAudioEvents
        })
        showToast('Transcription task started.', { type: 'success' })
        onSubmitted?.()
        onClose()
      } catch (error) {
        console.error('Failed to start transcription task', error)
        const message = error && typeof error === 'object' && 'message' in error ? String((error as { message: string }).message) : null
        showToast(message || 'Failed to start transcription task.', { type: 'error' })
      }
    })
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} processing={isPending} outerContent={outerContent} className="sm:max-w-[560px] md:max-w-[620px] lg:max-w-[640px]">
      <div className="px-4 py-6 sm:px-6">
        <h2 className="text-foreground text-lg font-semibold">Transcribe Audio</h2>
        <p className="text-foreground-muted mt-1 text-sm">Generate a WebVTT subtitle file from this audiobook&apos;s audio tracks.</p>

        <div className="mt-5 space-y-4">
          <TextInput label="API Key" type="password" value={apiKey} onChange={setApiKey} autocomplete="off" />

          <Dropdown label="Language" value={languageCode} items={languageOptions} onChange={(value) => setLanguageCode(value as 'en' | 'de')} />

          <Checkbox value={diarize} onChange={setDiarize} label="Enable speaker diarization" />

          <Checkbox value={tagAudioEvents} onChange={setTagAudioEvents} label="Tag audio events" />
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Btn size="small" color="bg-primary" className="border border-gray-600" onClick={onClose} disabled={isPending}>
            {t('ButtonCancel')}
          </Btn>
          <Btn size="small" color="bg-success" onClick={handleSubmit} disabled={isPending}>
            Start Transcribing
          </Btn>
        </div>
      </div>
    </Modal>
  )
}
