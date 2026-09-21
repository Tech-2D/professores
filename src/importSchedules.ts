import { CLASS_NAMES } from './classNames'
import { timeToMinutes } from './schedule'
import type { ScheduleInput } from './types'

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/
const allowedClasses = new Set<string>(CLASS_NAMES)

export function parseSchedulesJson(text: string): ScheduleInput[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('O arquivo não contém um JSON válido.')
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 5000) {
    throw new Error('O JSON precisa conter uma lista de 1 a 5.000 horários.')
  }

  const seen = new Set<string>()
  return value.map((item, index) => {
    const line = index + 1
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Registro ${line}: formato inválido.`)
    }
    const row = item as Record<string, unknown>
    const professor = requiredString(row.professor, line, 'professor')
    const subject = requiredString(row.subject, line, 'subject')
    const className = requiredString(row.className, line, 'className')
    const floor = optionalString(row.floor, line, 'floor')
    const roomDescription = optionalString(row.roomDescription, line, 'roomDescription')
    const startTime = requiredString(row.startTime, line, 'startTime')
    const endTime = requiredString(row.endTime, line, 'endTime')
    if (!allowedClasses.has(className)) throw new Error(`Registro ${line}: turma “${className}” não reconhecida.`)
    if (!timePattern.test(startTime) || !timePattern.test(endTime) || timeToMinutes(endTime) <= timeToMinutes(startTime)) {
      throw new Error(`Registro ${line}: horário inicial ou final inválido.`)
    }
    if (!Number.isInteger(row.dayOfWeek) || (row.dayOfWeek as number) < 1 || (row.dayOfWeek as number) > 6) {
      throw new Error(`Registro ${line}: dayOfWeek precisa estar entre 1 e 6.`)
    }
    if (typeof row.active !== 'boolean') throw new Error(`Registro ${line}: active precisa ser true ou false.`)

    const fingerprint = [className, row.dayOfWeek, startTime, endTime, professor, subject].join('|')
    if (seen.has(fingerprint)) throw new Error(`Registro ${line}: horário duplicado no JSON.`)
    seen.add(fingerprint)

    return {
      professor, subject, className, floor, startTime, endTime,
      roomDescription, dayOfWeek: row.dayOfWeek as number, active: row.active,
    }
  })
}

function requiredString(value: unknown, line: number, field: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Registro ${line}: campo ${field} vazio.`)
  return value.trim()
}

function optionalString(value: unknown, line: number, field: string) {
  if (typeof value !== 'string') throw new Error(`Registro ${line}: campo ${field} precisa ser texto.`)
  return value.trim()
}

export async function importDocumentId(schedule: ScheduleInput) {
  const identity = [schedule.className, schedule.dayOfWeek, schedule.startTime, schedule.endTime, schedule.professor, schedule.subject].join('|')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity))
  return `import_${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32)}`
}
