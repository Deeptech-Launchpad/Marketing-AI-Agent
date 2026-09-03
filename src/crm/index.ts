import { env } from '../config/env.js'
import type { CrmPort } from './crmPort.js'
import { FakeCrmAdapter } from './fake/fakeCrmAdapter.js'
import { NxtSalesAdapter } from './nxtSales/nxtSalesAdapter.js'

// Single place where the CRM implementation is chosen. Nothing else in the
// codebase imports a concrete adapter, which is what makes adding a second CRM
// a new file here rather than a change everywhere.

let instance: CrmPort | null = null

export function getCrm(): CrmPort {
  if (!instance) {
    instance = env.CRM_DRIVER === 'fake' ? new FakeCrmAdapter() : new NxtSalesAdapter()
  }
  return instance
}

/** Test seam — lets a suite inject a stub without touching env. */
export function setCrm(port: CrmPort | null): void {
  instance = port
}

export type { CrmPort }
