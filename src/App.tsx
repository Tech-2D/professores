import { type ChangeEvent, FormEvent, useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  CalendarDays,
  Check,
  DoorOpen,
  Edit3,
  KeyRound,
  LoaderCircle,
  LogOut,
  MapPin,
  Menu,
  Plus,
  Search,
  Settings,
  Trash2,
  Upload,
  UserRound,
  X,
} from 'lucide-react'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from 'firebase/auth'
import { FirebaseError } from 'firebase/app'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore'
import { auth, db } from './firebase'
import { CLASS_NAMES } from './classNames'
import { readPreferredClass, savePreferredClass } from './classPreference'
import { importDocumentId, parseSchedulesJson } from './importSchedules'
import { isHappeningNow, matchesSearch, timeToMinutes } from './schedule'
import { WEEKDAYS, type Schedule, type ScheduleInput } from './types'
import {
  NEON_COLORS,
  NEON_COLOR_LABELS,
  NEON_COLOR_SWATCHES,
  THEMES,
  THEME_LABELS,
  readStoredNeon,
  readStoredTheme,
  storeNeon,
  storeTheme,
  type NeonColor,
  type Theme,
} from './theme'

const emptyForm: ScheduleInput = {
  professor: '',
  subject: '',
  className: '',
  floor: '',
  startTime: '08:00',
  endTime: '09:00',
  roomDescription: '',
  dayOfWeek: 1,
  active: true,
}

type View = 'now' | 'today' | 'all'

function App() {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [search, setSearch] = useState('')
  const [classFilter, setClassFilter] = useState<string>(() => readPreferredClass() ?? CLASS_NAMES[0])
  const [subjectFilter, setSubjectFilter] = useState('')
  const [dayFilter, setDayFilter] = useState(0)
  const [view, setView] = useState<View>('all')
  const [adminOpen, setAdminOpen] = useState(window.location.hash === '#admin')
  const [menuOpen, setMenuOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [theme, setThemeState] = useState<Theme>(readStoredTheme)
  const [neon, setNeonState] = useState<NeonColor>(readStoredNeon)
  const [user, setUser] = useState<User | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [authChecked, setAuthChecked] = useState(false)
  const [now, setNow] = useState(new Date())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.neon = neon
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'neon' ? '#f4fbff' : '#0e35be')
  }, [theme, neon])

  function selectTheme(value: Theme) {
    setThemeState(value)
    storeTheme(value)
  }

  function selectNeon(value: NeonColor) {
    setNeonState(value)
    storeNeon(value)
  }

  function selectClass(value: string) {
    setClassFilter(value)
    if (value) savePreferredClass(value)
  }

  function clearSearch() {
    setSearch('')
    setClassFilter(readPreferredClass() ?? CLASS_NAMES[0])
  }

  useEffect(() => {
    const schedulesQuery = isAdmin
      ? query(collection(db, 'schedules'))
      : query(collection(db, 'schedules'), where('active', '==', true))
    return onSnapshot(
      schedulesQuery,
      (snapshot) => {
        setSchedules(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as Schedule))
        setLoading(false)
        setLoadError('')
      },
      () => {
        setLoading(false)
        setLoadError('Não foi possível carregar os horários. Confira a conexão e as regras do Firestore.')
      },
    )
  }, [isAdmin])

  useEffect(() => {
    let requestId = 0
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      const currentRequest = ++requestId
      setUser(currentUser)
      setIsAdmin(false)
      setAuthChecked(!currentUser)
      if (!currentUser) return

      try {
        const adminRecord = await getDoc(doc(db, 'admins', currentUser.uid))
        if (currentRequest === requestId) setIsAdmin(['admin', 'superadmin'].includes(adminRecord.data()?.role))
      } catch {
        if (currentRequest === requestId) setIsAdmin(false)
      } finally {
        if (currentRequest === requestId) setAuthChecked(true)
      }
    })
    return () => {
      requestId += 1
      unsubscribe()
    }
  }, [])

  const visibleSchedules = useMemo(() => {
    return schedules
      .filter((item) => item.active)
      .filter((item) => !classFilter || item.className === classFilter)
      .filter((item) => !subjectFilter || item.subject === subjectFilter)
      .filter((item) => matchesSearch(item, search))
      .filter((item) => {
        if (view === 'now') return isHappeningNow(item, now)
        if (view === 'today') return item.dayOfWeek === now.getDay()
        return !dayFilter || item.dayOfWeek === dayFilter
      })
      .sort((a, b) => a.dayOfWeek - b.dayOfWeek || timeToMinutes(a.startTime) - timeToMinutes(b.startTime))
  }, [schedules, classFilter, subjectFilter, dayFilter, search, view, now])

  const subjects = useMemo(() => [...new Set(schedules.filter((item) => item.active).map((item) => item.subject))].sort((a, b) => a.localeCompare(b, 'pt-BR')), [schedules])
  const displayedDays = WEEKDAYS.filter((weekday) => schedules.some((item) => item.active && item.dayOfWeek === weekday.value))
    .filter((weekday) => view === 'now' || view === 'today'
      ? weekday.value === now.getDay()
      : !dayFilter || weekday.value === dayFilter)
  const timeSlots = [...new Set(visibleSchedules.map((item) => item.startTime))].sort((a, b) => timeToMinutes(a) - timeToMinutes(b))

  const openAdmin = () => {
    window.location.hash = 'admin'
    setAdminOpen(true)
  }

  const closeAdmin = () => {
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    setAdminOpen(false)
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#inicio" aria-label="Cadê o professor? — início">
          <span className="brand-mark"><MapPin size={21} strokeWidth={2.3} /></span>
          <span>Cadê o professor?</span>
        </a>
        <button
          type="button"
          className="menu-trigger"
          aria-label="Abrir menu"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(true)}
        >
          <Menu size={22} strokeWidth={2.3} aria-hidden="true" />
        </button>
      </header>

      <main id="inicio" className="main-content">
        <div className="page-heading">
          <h1>Encontre seu professor</h1>
          <p>Consulte a grade por turma ou pesquise um professor, matéria ou local.</p>
        </div>

        <section className="search-section" aria-label="Pesquisar professores">
          <div className="search-box">
            <Search size={22} aria-hidden="true" />
            <input
              id="main-search"
              aria-label="Buscar professor, matéria ou turma"
              value={search}
              onChange={(event) => {
                const value = event.target.value
                setSearch(value)
                setClassFilter(value.trim() ? '' : readPreferredClass() ?? CLASS_NAMES[0])
              }}
              placeholder="Buscar professor, matéria, turma ou local"
              autoComplete="off"
            />
            {search && <button className="clear-search" onClick={clearSearch} aria-label="Limpar busca"><X size={18} /></button>}
          </div>
          <div className="view-switcher" aria-label="Filtrar horários">
            <button className={view === 'now' ? 'active' : ''} onClick={() => setView('now')}>Agora</button>
            <button className={view === 'today' ? 'active' : ''} onClick={() => setView('today')}>Hoje</button>
            <button className={view === 'all' ? 'active' : ''} onClick={() => setView('all')}>Semana</button>
          </div>
        </section>

        <div className="schedule-filters" aria-label="Filtros da grade">
          <label>Turma<select value={classFilter} onChange={(event) => selectClass(event.target.value)}><option value="">Todas as turmas</option>{CLASS_NAMES.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
          <label>Matéria<select value={subjectFilter} onChange={(event) => setSubjectFilter(event.target.value)}><option value="">Todas as matérias</option>{subjects.map((subject) => <option key={subject} value={subject}>{subject}</option>)}</select></label>
          <label>Dia<select value={dayFilter} onChange={(event) => { setDayFilter(Number(event.target.value)); setView('all') }}><option value={0}>Semana inteira</option>{WEEKDAYS.map((day) => <option key={day.value} value={day.value}>{day.label}</option>)}</select></label>
        </div>

        <section className="schedule-section" aria-labelledby="schedule-title">
          <div className="section-heading">
            <h2 id="schedule-title">{view === 'now' ? 'Em aula agora' : view === 'today' ? 'Grade de hoje' : 'Grade semanal'}</h2>
            <span>{view === 'now' ? now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : `${visibleSchedules.length} ${visibleSchedules.length === 1 ? 'horário' : 'horários'}`}</span>
          </div>

          {loading ? <div className="state-card"><LoaderCircle className="spin" /><p>Consultando os horários…</p></div>
            : loadError ? <div className="state-card error"><DoorOpen /><p>{loadError}</p></div>
            : visibleSchedules.length === 0 ? <EmptyState view={view} search={search} />
            : <div className="timetable-scroll" role="region" aria-label="Grade de horários" tabIndex={0}>
                <table className="timetable">
                  <thead><tr><th scope="col">Hora</th>{displayedDays.map((day) => <th scope="col" key={day.value}><span>{day.short}</span><small>{day.label}</small></th>)}</tr></thead>
                  <tbody>{timeSlots.map((time) => <tr key={time}><th scope="row">{time}</th>{displayedDays.map((day) => <td key={day.value}>{visibleSchedules.filter((item) => item.dayOfWeek === day.value && item.startTime === time).map((item) => <ScheduleCard key={item.id} schedule={item} now={now} />)}</td>)}</tr>)}</tbody>
                </table>
              </div>}
        </section>
      </main>

      {menuOpen && (
        <SideMenu
          theme={theme}
          onClose={() => setMenuOpen(false)}
          onOpenConfig={() => { setMenuOpen(false); setConfigOpen(true) }}
          onOpenAdmin={() => { setMenuOpen(false); openAdmin() }}
        />
      )}
      {configOpen && (
        <ConfigDialog
          theme={theme}
          neon={neon}
          onSetTheme={selectTheme}
          onSetNeon={selectNeon}
          onClose={() => setConfigOpen(false)}
        />
      )}

      {adminOpen && (
        <AdminDialog
          schedules={schedules}
          user={user}
          isAdmin={isAdmin}
          authChecked={authChecked}
          onClose={closeAdmin}
        />
      )}
    </div>
  )
}

function ScheduleCard({ schedule, now }: { schedule: Schedule; now: Date }) {
  const happening = isHappeningNow(schedule, now)
  const color = ['#06b6b9', '#69d71b', '#2782e6', '#f3ae45'][[...schedule.subject].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 4]
  return (
    <article className={`lesson-block ${happening ? 'happening' : ''}`} style={{ borderLeftColor: color }}>
      <div className="lesson-heading"><strong>{schedule.subject}</strong>{happening && <span>Agora</span>}</div>
      <p className="lesson-teacher">{schedule.professor}</p>
      <p className="lesson-meta">{schedule.startTime}–{schedule.endTime} · {schedule.className}</p>
      {(schedule.floor || schedule.roomDescription) && <p className="lesson-location">{[schedule.floor, schedule.roomDescription].filter(Boolean).join(' · ')}</p>}
    </article>
  )
}

function EmptyState({ view, search }: { view: View; search: string }) {
  const title = search ? 'Nenhum resultado para essa busca' : view === 'now' ? 'Nenhum professor em aula agora' : 'Nenhum horário encontrado'
  return (
    <div className="state-card empty">
      <span className="empty-icon"><Search /></span>
      <div><h3>{title}</h3><p>{search ? 'Tente o sobrenome, a matéria ou o nome da turma.' : 'Consulte outro período ou a semana completa.'}</p></div>
    </div>
  )
}

function SideMenu({ theme, onClose, onOpenConfig, onOpenAdmin }: { theme: Theme; onClose: () => void; onOpenConfig: () => void; onOpenAdmin: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="side-menu" role="dialog" aria-modal="true" aria-labelledby="menu-title">
        <div className="dialog-header">
          <h2 id="menu-title">Menu</h2>
          <button className="icon-button" onClick={onClose} aria-label="Fechar menu"><X /></button>
        </div>
        <nav className="side-menu-list">
          <a href="#inicio" onClick={onClose}><Search size={18} /> Buscar professores</a>
          <button type="button" onClick={onOpenConfig}>
            <Settings size={18} /> Configurações
            <span className="menu-current-theme">{THEME_LABELS[theme]}</span>
          </button>
          <button type="button" onClick={onOpenAdmin}><KeyRound size={18} /> Área administrativa</button>
          <a href="https://tech-2d.github.io/Agenda/" target="_blank" rel="noopener noreferrer"><CalendarDays size={18} /> Agenda da turma <ArrowRight size={15} className="menu-external-icon" /></a>
        </nav>
      </aside>
    </div>
  )
}

function ConfigDialog({ theme, neon, onSetTheme, onSetNeon, onClose }: {
  theme: Theme
  neon: NeonColor
  onSetTheme: (value: Theme) => void
  onSetNeon: (value: NeonColor) => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="config-dialog" role="dialog" aria-modal="true" aria-labelledby="config-title">
        <div className="dialog-header">
          <h2 id="config-title">Configurações</h2>
          <button className="icon-button" onClick={onClose} aria-label="Fechar configurações"><X /></button>
        </div>
        <div className="config-content">
          <h3>Aparência</h3>
          <p>Escolha como a grade e o menu aparecem para você.</p>
          <div className="theme-options" aria-label="Tema">
            {THEMES.map((value) => (
              <button type="button" key={value} className={`theme-swatch ${theme === value ? 'active' : ''}`} onClick={() => onSetTheme(value)} aria-pressed={theme === value}>
                <span className={`theme-dot theme-dot-${value}`} /> {THEME_LABELS[value]}
              </button>
            ))}
          </div>
          {theme === 'neon' && (
            <div className="neon-picker">
              <h3>Cor do neon</h3>
              <div className="neon-options" aria-label="Cor de destaque neon">
                {NEON_COLORS.map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={`neon-swatch ${neon === value ? 'active' : ''}`}
                    style={{ background: NEON_COLOR_SWATCHES[value] }}
                    onClick={() => onSetNeon(value)}
                    aria-label={NEON_COLOR_LABELS[value]}
                    aria-pressed={neon === value}
                    title={NEON_COLOR_LABELS[value]}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

type AdminDialogProps = {
  schedules: Schedule[]
  user: User | null
  isAdmin: boolean
  authChecked: boolean
  onClose: () => void
}

function AdminDialog({ schedules, user, isAdmin, authChecked, onClose }: AdminDialogProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [busy, setBusy] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Schedule | null>(null)
  const [form, setForm] = useState<ScheduleInput>(emptyForm)
  const [saveError, setSaveError] = useState('')
  const [notice, setNotice] = useState('')
  const [adminSearch, setAdminSearch] = useState('')
  const [importRows, setImportRows] = useState<ScheduleInput[]>([])
  const [importError, setImportError] = useState('')
  const [importProgress, setImportProgress] = useState('')

  const filteredAdminSchedules = schedules.filter((item) => matchesSearch(item, adminSearch))

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  async function logIn(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setAuthError('')
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password)
      setPassword('')
    } catch (error) {
      if (error instanceof FirebaseError && error.code === 'auth/too-many-requests') {
        setAuthError('Muitas tentativas de entrada. Aguarde um pouco antes de tentar novamente.')
      } else if (error instanceof FirebaseError && error.code === 'auth/network-request-failed') {
        setAuthError('Não foi possível conectar ao Firebase. Confira sua internet e tente novamente.')
      } else {
        setAuthError('E-mail ou senha inválidos.')
      }
    } finally {
      setBusy(false)
    }
  }

  function startCreate() {
    setEditing(null)
    setForm({ ...emptyForm, dayOfWeek: new Date().getDay() || 1 })
    setSaveError('')
    setFormOpen(true)
  }

  function startEdit(schedule: Schedule) {
    const { id: _id, ...values } = schedule
    void _id
    setEditing(schedule)
    setForm(values)
    setSaveError('')
    setFormOpen(true)
  }

  async function saveSchedule(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setSaveError('')
    try {
      if (timeToMinutes(form.endTime) <= timeToMinutes(form.startTime)) {
        throw new Error('O horário final precisa ser depois do horário inicial.')
      }
      if (editing) {
        await updateDoc(doc(db, 'schedules', editing.id), { ...form, updatedAt: serverTimestamp() })
        setNotice('Horário atualizado.')
      } else {
        await addDoc(collection(db, 'schedules'), { ...form, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
        setNotice('Horário adicionado.')
      }
      setFormOpen(false)
      window.setTimeout(() => setNotice(''), 2800)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Não foi possível salvar o horário.')
    } finally {
      setBusy(false)
    }
  }

  async function removeSchedule(schedule: Schedule) {
    if (!window.confirm(`Excluir o horário de ${schedule.professor}?`)) return
    try {
      await deleteDoc(doc(db, 'schedules', schedule.id))
      setNotice('Horário excluído.')
      window.setTimeout(() => setNotice(''), 2800)
    } catch {
      setNotice('Não foi possível excluir o horário.')
    }
  }

  async function readImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    setImportRows([])
    setImportError('')
    setImportProgress('')
    if (!file) return
    try {
      const rows = parseSchedulesJson(await file.text())
      setImportRows(rows)
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'Não foi possível ler o arquivo.')
    }
  }

  async function importSchedules() {
    if (!isAdmin || importRows.length === 0) return
    setBusy(true)
    setImportError('')
    let processed = 0
    try {
      const existingById = new Map(schedules.map((schedule) => [schedule.id, schedule]))
      const pending: { id: string; schedule: ScheduleInput; updateActive: boolean }[] = []
      for (const schedule of importRows) {
        const id = await importDocumentId(schedule)
        const existing = existingById.get(id)
        if (!existing || existing.active !== schedule.active) pending.push({ id, schedule, updateActive: Boolean(existing) })
      }
      if (pending.length === 0) {
        setNotice('Todos os horários deste JSON já estão cadastrados com o status atualizado.')
        setImportRows([])
        return
      }
      for (let offset = 0; offset < pending.length; offset += 400) {
        const batch = writeBatch(db)
        const chunk = pending.slice(offset, offset + 400)
        for (const { id, schedule, updateActive } of chunk) {
          const reference = doc(db, 'schedules', id)
          if (updateActive) {
            batch.update(reference, { active: schedule.active, updatedAt: serverTimestamp() })
          } else {
            batch.set(reference, { ...schedule, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
          }
        }
        await batch.commit()
        processed += chunk.length
        setImportProgress(`${processed} de ${pending.length} horários processados`)
      }
      const updated = pending.filter((item) => item.updateActive).length
      setNotice(`${pending.length - updated} horários cadastrados e ${updated} status atualizados. A localização pode ser preenchida depois.`)
      setImportRows([])
      setImportProgress('')
    } catch {
      setImportError(`A importação parou após ${processed} horários. Confira a conexão e as permissões antes de tentar novamente.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="admin-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-title">
        <div className="dialog-header">
          <div><p className="eyebrow dark">ACESSO RESTRITO</p><h2 id="admin-title">Área administrativa</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Fechar"><X /></button>
        </div>

        {!authChecked ? (
          <div className="state-card"><LoaderCircle className="spin" /><p>Verificando acesso…</p></div>
        ) : !user ? (
          <form className="login-form" onSubmit={logIn}>
            <div className="login-symbol"><KeyRound /></div>
            <h3>Entre para gerenciar os horários</h3>
            <p>Use o e-mail e a senha da sua conta no Firebase Authentication.</p>
            <label htmlFor="admin-email">E-mail</label>
            <input id="admin-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" autoFocus required />
            <label htmlFor="admin-password">Senha</label>
            <input id="admin-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
            {authError && <p className="form-error">{authError}</p>}
            <button className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" /> : <>Entrar <ArrowRight /></>}</button>
          </form>
        ) : !isAdmin ? (
          <div className="unauthorized">
            <DoorOpen /><h3>Esta conta não tem permissão</h3><p>Confira se há um documento com o UID desta conta em <code>admins</code> e o campo <code>role</code> igual a <code>admin</code> ou <code>superadmin</code>.</p>
            <button className="secondary-button" onClick={() => signOut(auth)}>Sair</button>
          </div>
        ) : (
          <div className="admin-content">
            <div className="admin-toolbar">
              <div><span>Conectado como</span><strong>{user.email}</strong></div>
              <div className="toolbar-actions">
                <button className="secondary-button" onClick={() => signOut(auth)}><LogOut size={17} /> Sair</button>
                <button className="primary-button compact" onClick={startCreate}><Plus size={18} /> Novo horário</button>
              </div>
            </div>
            {notice && <div className="notice"><Check size={17} /> {notice}</div>}
            <div className="import-panel">
              <div className="import-copy"><strong>Importar horários por JSON</strong><span>Os horários ativos ficam visíveis mesmo sem localização. Reimportar atualiza o status dos horários já cadastrados.</span></div>
              <label className="import-file">Escolher JSON<input type="file" accept=".json,application/json" onChange={readImportFile} disabled={busy} /></label>
              {importRows.length > 0 && <div className="import-preview"><span>{importRows.length} horários validados · {new Set(importRows.map((row) => row.className)).size} turmas</span><button className="primary-button compact" onClick={importSchedules} disabled={busy}><Upload size={16} /> {busy ? 'Importando…' : 'Cadastrar horários'}</button></div>}
              {importProgress && <p className="import-progress" role="status">{importProgress}</p>}
              {importError && <p className="form-error" role="alert">{importError}</p>}
            </div>
            <div className="admin-list-heading"><strong>Horários cadastrados</strong><input aria-label="Buscar horários cadastrados" placeholder="Buscar professor ou turma" value={adminSearch} onChange={(event) => setAdminSearch(event.target.value)} /></div>
            <div className="admin-list">
              {filteredAdminSchedules.length === 0 ? <p className="admin-empty">Nenhum horário encontrado.</p> : filteredAdminSchedules.map((schedule) => (
                <article key={schedule.id} className="admin-row">
                  <div className="avatar"><UserRound /></div>
                  <div className="admin-row-main"><strong>{schedule.professor}</strong><span>{schedule.subject} · {schedule.className}</span></div>
                  <div className="admin-row-meta"><span>{WEEKDAYS.find((item) => item.value === schedule.dayOfWeek)?.short}</span><strong>{schedule.startTime}—{schedule.endTime}</strong></div>
                  <div className="row-actions">
                    <button onClick={() => startEdit(schedule)} aria-label={`Editar horário de ${schedule.professor}`}><Edit3 /></button>
                    <button className="danger" onClick={() => removeSchedule(schedule)} aria-label={`Excluir horário de ${schedule.professor}`}><Trash2 /></button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        )}

        {formOpen && (
          <div className="form-overlay">
            <form className="schedule-form" onSubmit={saveSchedule}>
              <div className="form-title"><div><p className="eyebrow dark">HORÁRIO</p><h3>{editing ? 'Editar aula' : 'Adicionar aula'}</h3></div><button type="button" className="icon-button" onClick={() => setFormOpen(false)}><X /></button></div>
              <div className="form-grid">
                <label>Professor<input required value={form.professor} onChange={(event) => setForm({ ...form, professor: event.target.value })} /></label>
                <label>Matéria<input required value={form.subject} onChange={(event) => setForm({ ...form, subject: event.target.value })} /></label>
                <label>Turma<select required value={form.className} onChange={(event) => setForm({ ...form, className: event.target.value })}><option value="">Selecione a turma</option>{CLASS_NAMES.map((name) => <option value={name} key={name}>{name}</option>)}</select></label>
                <label>Andar<input value={form.floor} onChange={(event) => setForm({ ...form, floor: event.target.value })} placeholder="Ex.: 1º andar" /></label>
                <label>Dia da semana<select value={form.dayOfWeek} onChange={(event) => setForm({ ...form, dayOfWeek: Number(event.target.value) })}>{WEEKDAYS.map((weekday) => <option value={weekday.value} key={weekday.value}>{weekday.label}</option>)}</select></label>
                <div className="time-fields"><label>Início<input required type="time" value={form.startTime} onChange={(event) => setForm({ ...form, startTime: event.target.value })} /></label><label>Fim<input required type="time" value={form.endTime} onChange={(event) => setForm({ ...form, endTime: event.target.value })} /></label></div>
                <label className="wide">Descrição de onde fica a sala<textarea rows={3} value={form.roomDescription} onChange={(event) => setForm({ ...form, roomDescription: event.target.value })} placeholder="Ex.: Sala 12, corredor à direita da biblioteca." /></label>
                <label className="toggle wide"><input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} /><span /> Horário visível no site</label>
              </div>
              {saveError && <p className="form-error">{saveError}</p>}
              <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setFormOpen(false)}>Cancelar</button><button className="primary-button compact" disabled={busy}>{busy ? <LoaderCircle className="spin" /> : 'Salvar horário'}</button></div>
            </form>
          </div>
        )}
      </section>
    </div>
  )
}

export default App
