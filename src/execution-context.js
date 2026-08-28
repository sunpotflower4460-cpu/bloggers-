// @feature F-012
import { AsyncLocalStorage } from 'node:async_hooks'

const executionContext = new AsyncLocalStorage()

function composeWriteFences(parent, current) {
  if (typeof parent !== 'function') return current
  if (typeof current !== 'function') return parent
  return async (detail) => {
    const parentResult = await parent(detail)
    const currentResult = await current(detail)
    return { parent: parentResult ?? null, current: currentResult ?? null }
  }
}

export function withExecutionContext(context, work) {
  if (typeof work !== 'function') throw new Error('Execution context requires a work function')
  const parent = executionContext.getStore() ?? {}
  const next = context ?? {}
  const merged = { ...parent, ...next }
  merged.beforeExternalWrite = composeWriteFences(parent.beforeExternalWrite, next.beforeExternalWrite)
  return executionContext.run(merged, work)
}

export function currentExecutionContext() {
  return executionContext.getStore() ?? null
}

export async function beforeExternalWrite(detail = {}) {
  const context = currentExecutionContext()
  if (typeof context?.beforeExternalWrite !== 'function') return null
  return context.beforeExternalWrite({
    jobId: context.jobId ?? null,
    workerId: context.workerId ?? null,
    operationLeaseKey: context.operationLeaseKey ?? null,
    ...detail,
  })
}
