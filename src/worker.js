// @feature F-004
// @feature F-005
// @feature F-010
// @feature F-012
import { recordActivity } from './orchestrator.js'
import { runBlogCycleExclusive, runPortfolioCycleExclusive } from './runtime.js'
import { createScheduler } from './scheduler.js'
import { createStore } from './storage.js'

const store = await createStore()
const scheduler = createScheduler({
  store,
  runPortfolioCycle: runPortfolioCycleExclusive,
  runBlogCycle: runBlogCycleExclusive,
  recordActivity,
})

scheduler.start({ keepAlive: true })
console.log(`Bloggers worker running (storage=${store.backend ?? 'unknown'})`)

function shutdown() {
  scheduler.stop()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
