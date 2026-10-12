// Test stand-in for vite-plugin-pwa's virtual module (the plugin is not loaded in Vitest).
import { useState } from 'react'

export function useRegisterSW() {
  const offlineReady = useState(false)
  const needRefresh = useState(false)
  return { offlineReady, needRefresh, updateServiceWorker: () => Promise.resolve() }
}
