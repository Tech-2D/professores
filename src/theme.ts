export const THEMES = ['padrao', 'neon'] as const
export type Theme = (typeof THEMES)[number]

export const THEME_LABELS: Record<Theme, string> = {
  padrao: 'Padrão',
  neon: 'Claro com neon',
}

export const NEON_COLORS = ['vermelho', 'roxo', 'verde', 'azul', 'rosa'] as const
export type NeonColor = (typeof NEON_COLORS)[number]

export const NEON_COLOR_LABELS: Record<NeonColor, string> = {
  vermelho: 'Vermelho',
  roxo: 'Roxo',
  verde: 'Verde claro',
  azul: 'Azul',
  rosa: 'Rosa',
}

export const NEON_COLOR_SWATCHES: Record<NeonColor, string> = {
  vermelho: '#ff2b54',
  roxo: '#b430ff',
  verde: '#39ff8f',
  azul: '#25e0ff',
  rosa: '#ff2ec4',
}

const THEME_KEY = 'professores:theme'
const NEON_KEY = 'professores:neon'

export function readStoredTheme(): Theme {
  try {
    const value = window.localStorage.getItem(THEME_KEY)
    return (THEMES as readonly string[]).includes(value ?? '') ? value as Theme : 'padrao'
  } catch {
    return 'padrao'
  }
}

export function readStoredNeon(): NeonColor {
  try {
    const value = window.localStorage.getItem(NEON_KEY)
    return (NEON_COLORS as readonly string[]).includes(value ?? '') ? value as NeonColor : 'azul'
  } catch {
    return 'azul'
  }
}

export function storeTheme(theme: Theme) {
  try {
    window.localStorage.setItem(THEME_KEY, theme)
  } catch {
    // A preferência continua funcionando até a página ser fechada.
  }
}

export function storeNeon(neon: NeonColor) {
  try {
    window.localStorage.setItem(NEON_KEY, neon)
  } catch {
    // A preferência continua funcionando até a página ser fechada.
  }
}
