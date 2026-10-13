/**
 * Client for the analyzer API (`/api/...` on the same origin). Types come from
 * `@barrefree/contracts`, generated from the analyzer's Pydantic models.
 */
import type { ApiError, Health, JobCreated, JobInfo } from '@barrefree/contracts'

export class ApiRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function errorFrom(response: Response): Promise<ApiRequestError> {
  let detail = response.statusText
  try {
    const body = (await response.json()) as Partial<ApiError>
    if (typeof body.detail === 'string') detail = body.detail
  } catch {
    // not JSON
  }
  return new ApiRequestError(response.status, detail)
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, signal ? { signal } : {})
  if (!response.ok) throw await errorFrom(response)
  return (await response.json()) as T
}

/** Null when the analyzer is unreachable (static hosting, offline). */
export async function fetchHealth(signal?: AbortSignal): Promise<Health | null> {
  try {
    return await getJson<Health>('/api/health', signal)
  } catch {
    return null
  }
}

export function fetchJob(id: string, signal?: AbortSignal): Promise<JobInfo> {
  return getJson<JobInfo>(`/api/jobs/${encodeURIComponent(id)}`, signal)
}

export async function fetchJobAudio(id: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(
    `/api/jobs/${encodeURIComponent(id)}/audio`,
    signal ? { signal } : {},
  )
  if (!response.ok) throw await errorFrom(response)
  return response.blob()
}

export interface UploadOptions {
  recognizer?: string
  separate?: boolean
  transcribe?: boolean
  /** Upload progress in [0, 1]. */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

/**
 * Uploads an audio file and returns the new job's id. Uses XMLHttpRequest because fetch() has no
 * upload progress, and a song on a phone connection can take a while.
 */
export function uploadAudio(file: File, options: UploadOptions = {}): Promise<string> {
  const form = new FormData()
  form.append('file', file, file.name)
  if (options.recognizer) form.append('recognizer', options.recognizer)
  if (options.separate) form.append('separate', 'true')
  if (options.transcribe) form.append('transcribe', 'true')
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/jobs')
    xhr.responseType = 'json'
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) options.onProgress?.(e.loaded / e.total)
    }
    xhr.onload = () => {
      const body = xhr.response as Partial<JobCreated & ApiError> | null
      if (xhr.status === 201 && typeof body?.jobId === 'string') resolve(body.jobId)
      else reject(new ApiRequestError(xhr.status, body?.detail ?? xhr.statusText))
    }
    xhr.onerror = () => reject(new ApiRequestError(0, 'network error'))
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'))
    options.signal?.addEventListener('abort', () => xhr.abort())
    xhr.send(form)
  })
}

export type JobEvent =
  | { type: 'job'; job: JobInfo }
  | { type: 'end'; outcome: string }
  /** The stream failed for good (e.g. 404: the job expired); transient drops reconnect. */
  | { type: 'error' }

/** Follows a job over Server-Sent Events; returns a function that stops listening. */
export function watchJob(id: string, onEvent: (event: JobEvent) => void): () => void {
  const source = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`)
  source.addEventListener('job', (e) => {
    onEvent({ type: 'job', job: JSON.parse((e as MessageEvent<string>).data) as JobInfo })
  })
  source.addEventListener('end', (e) => {
    onEvent({ type: 'end', outcome: JSON.parse((e as MessageEvent<string>).data) as string })
    source.close()
  })
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) onEvent({ type: 'error' })
  }
  return () => source.close()
}
