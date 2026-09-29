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
    mockSearch('?view=semana')
    expect(readViewParam()).toBe('all')
  })

  it('usa a grade de hoje quando não há visão pedida ou o valor é desconhecido', () => {
    mockSearch('')
    expect(readViewParam()).toBe('today')
    mockSearch('?view=mensal')
    expect(readViewParam()).toBe('today')
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
