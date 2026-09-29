import { CLASS_NAMES } from './classNames'

export type View = 'now' | 'today' | 'all'

// Permite abrir o site já numa visão específica, ex.: um atalho na Agenda
// linkando para ?turma=2%C2%BA%20Tec%20D&view=hoje. Sem parâmetro, o padrão
// é "Hoje" — a grade da semana inteira só aparece se for pedida.
const VIEW_BY_PARAM: Record<string, View> = { agora: 'now', hoje: 'today', semana: 'all' }

export function readViewParam(): View {
  const value = new URLSearchParams(window.location.search).get('view') ?? ''
  return VIEW_BY_PARAM[value] ?? 'today'
}

export function readClassParam(): string | null {
  const value = new URLSearchParams(window.location.search).get('turma')
  return value && (CLASS_NAMES as readonly string[]).includes(value) ? value : null
}
