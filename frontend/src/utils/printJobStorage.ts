/**
 * Persistent sessionStorage helpers for tracking failed print jobs.
 * Survives iOS backgrounding; cleared on successful retry.
 */

const KEY = 'bola8_pending_print_jobs'

export interface PendingPrintJob {
  job_id: string
  ticketId: string
  type: 'RECEIPT' | 'CHIT' | 'REPRINT'
  timestamp: number
}

function readAll(): PendingPrintJob[] {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) || '[]')
  } catch {
    return []
  }
}

function writeAll(jobs: PendingPrintJob[]) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(jobs))
  } catch {}
}

export function getPendingJob(ticketId: string): PendingPrintJob | null {
  return readAll().find((j) => j.ticketId === ticketId) ?? null
}

export function storePendingJob(job: PendingPrintJob) {
  const jobs = readAll().filter((j) => j.ticketId !== job.ticketId)
  jobs.push(job)
  writeAll(jobs)
}

export function removePendingJob(ticketId: string) {
  writeAll(readAll().filter((j) => j.ticketId !== ticketId))
}

export function hasPrinted(ticketId: string): boolean {
  return !!sessionStorage.getItem(`bola8_printed_${ticketId}`)
}

export function markPrinted(ticketId: string) {
  try {
    sessionStorage.setItem(`bola8_printed_${ticketId}`, '1')
  } catch {}
}
