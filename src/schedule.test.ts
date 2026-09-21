import { describe, expect, it } from 'vitest'
import { isHappeningNow, matchesSearch, timeToMinutes } from './schedule'
import type { Schedule } from './types'

const schedule: Schedule = {
  id: '1',
  professor: 'Ana Cláudia',
  subject: 'Matemática',
  className: '2º A',
  floor: '1º andar',
  startTime: '08:00',
  endTime: '09:30',
  roomDescription: 'Sala 12, ao lado da biblioteca',
  dayOfWeek: 1,
  active: true,
}

describe('schedule helpers', () => {
  it('converte horários em minutos', () => {
    expect(timeToMinutes('09:30')).toBe(570)
  })

  it('identifica uma aula acontecendo agora', () => {
    expect(isHappeningNow(schedule, new Date(2026, 8, 21, 8, 45))).toBe(true)
    expect(isHappeningNow(schedule, new Date(2026, 8, 21, 9, 30))).toBe(false)
  })

  it('busca sem diferenciar acentos ou maiúsculas', () => {
    expect(matchesSearch(schedule, 'claudia')).toBe(true)
    expect(matchesSearch(schedule, 'MATEMATICA')).toBe(true)
    expect(matchesSearch(schedule, 'biblioteca')).toBe(true)
  })
})
