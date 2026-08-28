// @feature F-002
// @feature F-012

function clone(value) {
  return structuredClone(value)
}

export async function createBlogRecord(store, blog) {
  if (!blog?.id) throw new Error('Blog id is required')
  if (!blog?.slug) throw new Error('Blog slug is required')
  if (typeof store.blogCreate === 'function') return store.blogCreate(clone(blog))

  return store.mutate((state) => {
    state.blogs ??= []
    if (state.blogs.some((item) => item.id === blog.id)) throw new Error('Blog already exists')
    if (state.blogs.some((item) => item.slug === blog.slug)) throw new Error('A blog with this slug already exists')
    state.blogs.push(clone(blog))
    return clone(blog)
  })
}

export async function mutateBlogRecord(store, blogId, mutator) {
  if (!blogId) throw new Error('blogId is required')
  if (typeof mutator !== 'function') throw new Error('blog mutator must be a function')
  if (typeof store.blogMutate === 'function') return store.blogMutate(blogId, mutator)

  return store.mutate(async (state) => {
    const blog = (state.blogs ?? []).find((item) => item.id === blogId)
    if (!blog) throw new Error('Blog not found')
    return mutator(blog)
  })
}

export async function listBlogRecords(store, { active = null, limit = 1000 } = {}) {
  if (typeof store.blogList === 'function') return store.blogList({ active, limit })
  const state = await store.read()
  const blogs = Array.isArray(state.blogs) ? state.blogs : []
  return blogs
    .filter((blog) => active === null || Boolean(blog.active) === Boolean(active))
    .slice(0, Math.max(1, Math.min(10_000, Number(limit) || 1000)))
    .map((blog) => clone(blog))
}
