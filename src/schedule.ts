import type { Schedule } from './types'

export function timeToMinutes(time: string) {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

export function isDuringSlot(schedule: Schedule, slotTime: string) {
  const slot = timeToMinutes(slotTime)
  return slot >= timeToMinutes(schedule.startTime) && slot < timeToMinutes(schedule.endTime)
}

export function isHappeningNow(schedule: Schedule, now = new Date()) {
  if (!schedule.active || schedule.dayOfWeek !== now.getDay()) return false
  const current = now.getHours() * 60 + now.getMinutes()
  return current >= timeToMinutes(schedule.startTime) && current < timeToMinutes(schedule.endTime)
}

export function isLaterToday(schedule: Schedule, now = new Date()) {
  if (!schedule.active || schedule.dayOfWeek !== now.getDay()) return false
  const current = now.getHours() * 60 + now.getMinutes()
  return current < timeToMinutes(schedule.startTime)
}

export function normalize(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
}

export function matchesSearch(schedule: Schedule, term: string) {
  const query = normalize(term)
  if (!query) return true
  return [schedule.professor, schedule.subject, schedule.className, schedule.floor, schedule.roomDescription]
    .some((field) => normalize(field).includes(query))
}
