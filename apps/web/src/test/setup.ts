import 'fake-indexeddb/auto'
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

import { initI18n } from '../i18n'
import { closeLibrary } from '../lib/library'

initI18n()

// Node's URL.createObjectURL only accepts Node Blobs, not jsdom's (or IndexedDB clones of them).
URL.createObjectURL = () => 'blob:test'
URL.revokeObjectURL = () => undefined

afterEach(async () => {
  cleanup()
  localStorage.clear()
  window.history.replaceState(null, '', '/')
  await closeLibrary()
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('barrefree')
    request.onsuccess = request.onerror = request.onblocked = () => resolve()
  })
})
