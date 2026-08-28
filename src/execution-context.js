// @feature F-012
import { AsyncLocalStorage } from 'node:async_hooks'

const executionContext = new AsyncLocalStorage()

export function withExecutionContext(context, work) {
  if (typeof work !== 'function') throw new Error('Execution context requires a work function')
  return executionContext.run(context ?? {}, work)
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
    ...detail,
  })
}
