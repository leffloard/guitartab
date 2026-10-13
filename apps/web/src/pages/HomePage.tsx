import type { Health } from '@barrefree/contracts'

import { UploadCard } from '../components/UploadCard'
import type { Settings } from '../hooks/useSettings'
import { TextMode } from './TextMode'

/** Two ways in: analyze a recording, or paste a chord sheet (works offline). */
export function HomePage({
  settings,
  health,
  healthLoaded,
}: {
  settings: Settings
  health: Health | null
  healthLoaded: boolean
}) {
  return (
    <>
      <UploadCard health={health} healthLoaded={healthLoaded} />
      <TextMode settings={settings} />
    </>
  )
}
