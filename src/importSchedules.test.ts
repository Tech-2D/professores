import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseSchedulesJson } from './importSchedules'

const valid = {
  professor: 'Ana Silva', subject: 'Matemática', className: '6º A', floor: '',
  startTime: '07:00', endTime: '07:50', roomDescription: '', dayOfWeek: 1, active: false,
}

describe('importação de horários', () => {
  it('aceita aulas sem localização ativas ou inativas', () => {
    expect(parseSchedulesJson(JSON.stringify([valid]))).toHaveLength(1)
    expect(parseSchedulesJson(JSON.stringify([{ ...valid, active: true }]))[0].active).toBe(true)
  })

  it('rejeita turma desconhecida e horários duplicados', () => {
    expect(() => parseSchedulesJson(JSON.stringify([{ ...valid, className: '6º Z' }]))).toThrow('não reconhecida')
    expect(() => parseSchedulesJson(JSON.stringify([valid, valid]))).toThrow('duplicado')
  })

  it('valida o JSON gerado da planilha inteira', () => {
    const text = readFileSync(new URL('../data/horarios-turmas.json', import.meta.url), 'utf8')
    const rows = parseSchedulesJson(text)
    expect(rows).toHaveLength(1369)
    expect(new Set(rows.map((row) => row.className)).size).toBe(44)
    expect(rows.some((row) => row.className === '2º Neg B')).toBe(true)
    expect(rows.every((row) => row.active && !row.floor && !row.roomDescription)).toBe(true)
  })
})
