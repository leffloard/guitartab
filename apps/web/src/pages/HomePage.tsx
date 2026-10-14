import type { Health } from '@barrefree/contracts'

import { LinkCard } from '../components/LinkCard'
import { UploadCard } from '../components/UploadCard'
import type { Settings } from '../hooks/useSettings'
import { TextMode } from './TextMode'

/** Ways in: analyze a recording (or a link, when enabled), or paste a chord sheet (offline). */
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
      {health?.features.urlImport && health.features.recognizers.length > 0 && (
        <LinkCard health={health} />
      )}
      <TextMode settings={settings} />
    </>
  )
}
