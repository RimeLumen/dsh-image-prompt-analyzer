
export function lazy(factory) {
  let pending = null
  return {
    get() {
      if (!pending) {
        pending = Promise.resolve()
          .then(factory)
          .catch((error) => {
            pending = null
            throw error
          })
      }
      return pending
    },
    peek() {
      return pending
    },
    reset() {
      pending = null
    },
  }
}
