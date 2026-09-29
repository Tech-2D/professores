import { afterEach, describe, expect, it, vi } from 'vitest'
import { readClassParam, readViewParam } from './viewParams'

afterEach(() => vi.unstubAllGlobals())

function mockSearch(search: string) {
  vi.stubGlobal('window', { location: { search } })
}

describe('parâmetros de URL para abrir direto numa turma/visão', () => {
  it('lê a visão pedida na URL', () => {
    mockSearch('?view=hoje')
    expect(readViewParam()).toBe('today')
    mockSearch('?view=agora')
    expect(readViewParam()).toBe('now')
  })

  it('usa a grade semanal quando não há visão pedida ou o valor é desconhecido', () => {
    mockSearch('')
    expect(readViewParam()).toBe('all')
    mockSearch('?view=mensal')
    expect(readViewParam()).toBe('all')
  })

  it('lê a turma pedida na URL, só se for uma turma conhecida', () => {
    mockSearch(`?turma=${encodeURIComponent('2º Tec D')}`)
    expect(readClassParam()).toBe('2º Tec D')
    mockSearch('?turma=turma+inexistente')
    expect(readClassParam()).toBeNull()
    mockSearch('')
    expect(readClassParam()).toBeNull()
  })
})
