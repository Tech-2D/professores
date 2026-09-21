export const WEEKDAYS = [
  { value: 1, label: 'Segunda-feira', short: 'Seg' },
  { value: 2, label: 'Terça-feira', short: 'Ter' },
  { value: 3, label: 'Quarta-feira', short: 'Qua' },
  { value: 4, label: 'Quinta-feira', short: 'Qui' },
  { value: 5, label: 'Sexta-feira', short: 'Sex' },
  { value: 6, label: 'Sábado', short: 'Sáb' },
] as const

export type Schedule = {
  id: string
  professor: string
  subject: string
  className: string
  floor: string
  startTime: string
  endTime: string
  roomDescription: string
  dayOfWeek: number
  active: boolean
}

export type ScheduleInput = Omit<Schedule, 'id'>
