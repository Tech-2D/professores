export async function mapLimited(items, concurrency, action) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('INVALID_CONCURRENCY')
  const results = new Array(items.length)
  let next = 0, failed = false, failure
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++
      try { results[index] = await action(items[index], index) }
      catch (error) { failed = true; failure ||= error }
    }
  }))
  if (failed) throw failure
  return results
}
