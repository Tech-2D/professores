import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPreferredClass, savePreferredClass } from './classPreference'

afterEach(() => vi.unstubAllGlobals())

function mockStorage(values = new Map<string, string>()) {
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } })
  return values
}

describe('preferência de turma em Cadê o professor?', () => {
  it('lê a turma compartilhada e a escolha antiga da Agenda', () => {
    const values = mockStorage(new Map([['agenda:turma', '2° TECH F']]))
    expect(readPreferredClass()).toBe('2º Tec F')
    values.set('tech-2d:preferredClass', '8º A')
    expect(readPreferredClass()).toBe('8º A')
  })

  it('salva apenas turmas válidas, sem apagar a preferência ao mostrar todas', () => {
    const values = mockStorage()
    savePreferredClass('2º Tec I')
    savePreferredClass('')
    expect(values.get('tech-2d:preferredClass')).toBe('2º Tec I')
  })

  it('ignora valores compartilhados inválidos', () => {
    mockStorage(new Map([['tech-2d:preferredClass', 'turma inexistente']]))
    expect(readPreferredClass()).toBeNull()
  })
})
