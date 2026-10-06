import { describe, expect, it } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useAsync } from './hooks'

// WHAT IS ON SCREEN BELONGS TO WHAT IS SELECTED (2026-10-06).
//
// The loader used to keep the previous answer when its key changed. Switching
// company therefore showed company A's data under company B's name until B's
// answer landed — and kept A's data there for good if B's request failed. A
// refresh of the SAME key still keeps the current answer on screen, so polling
// does not flicker.

const deferred = () => {
  let resolve!: (v: string) => void
  let reject!: (e: Error) => void
  const promise = new Promise<string>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useAsync', () => {
  it('clears the previous company’s data the moment the company changes', async () => {
    const pending: Record<string, ReturnType<typeof deferred>> = {}
    const { result, rerender } = renderHook(({ id }) => useAsync(() => (pending[id] = deferred()).promise, [id]), {
      initialProps: { id: 'A' },
    })
    await act(async () => pending.A!.resolve('company A'))
    expect(result.current.data).toBe('company A')

    rerender({ id: 'B' })
    // B has not answered yet: nothing of A's may be shown under B.
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(true)

    await act(async () => pending.B!.resolve('company B'))
    expect(result.current.data).toBe('company B')
  })

  it('never leaves the previous company’s data up when the new request fails', async () => {
    const pending: Record<string, ReturnType<typeof deferred>> = {}
    const { result, rerender } = renderHook(({ id }) => useAsync(() => (pending[id] = deferred()).promise, [id]), {
      initialProps: { id: 'A' },
    })
    await act(async () => pending.A!.resolve('company A'))

    rerender({ id: 'B' })
    await act(async () => pending.B!.reject(new Error('B could not be read')))

    expect(result.current.data).toBeNull()
    expect(result.current.error?.message).toBe('B could not be read')
  })

  it('keeps the current data on screen during a refresh of the same company', async () => {
    let n = 0
    const { result } = renderHook(() => useAsync(async () => `read ${++n}`, ['A']))
    await waitFor(() => expect(result.current.data).toBe('read 1'))

    act(() => result.current.refresh())
    // Still showing the last answer while the refresh runs — no flicker.
    expect(result.current.data).toBe('read 1')
    await waitFor(() => expect(result.current.data).toBe('read 2'))
  })

  it('does not carry an old company’s error over to the next one', async () => {
    const pending: Record<string, ReturnType<typeof deferred>> = {}
    const { result, rerender } = renderHook(({ id }) => useAsync(() => (pending[id] = deferred()).promise, [id]), {
      initialProps: { id: 'A' },
    })
    await act(async () => pending.A!.resolve('company A'))
    rerender({ id: 'B' })
    await act(async () => pending.B!.reject(new Error('B failed')))
    rerender({ id: 'C' })
    expect(result.current.error).toBeNull()
  })
})
