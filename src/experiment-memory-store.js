// @feature F-011
// @feature F-012

export async function transactExperimentMemory(store, blogId, mutator) {
  if (!blogId) throw new Error('blogId is required for experiment/memory transaction')
  if (typeof mutator !== 'function') throw new Error('experiment/memory mutator must be a function')

  if (typeof store.experimentMemoryTransaction === 'function') {
    return store.experimentMemoryTransaction(blogId, mutator)
  }

  return store.mutate(async (state) => mutator({
    experiments: state.experiments,
    memories: state.memories,
  }))
}
