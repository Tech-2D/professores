import { type FormEvent, useEffect, useState } from 'react'
import { createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from 'firebase/auth'
import { auth } from './firebase'
import './profiles.css'

const API = 'https://tech-2d-auth-email.vercel.app'
type Profile = { uid: string; displayName: string; company: string; className: string; room: string; floor: string; photoUrl: string | null }
type Fields = Pick<Profile, 'displayName' | 'company' | 'className' | 'room' | 'floor'>
const empty: Fields = { displayName: '', company: '', className: '', room: '', floor: '' }

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${API}${path}`, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.message || 'Não foi possível carregar os perfis.')
  return data
}

export function ProfileDialog({ onClose }: { onClose: () => void }) {
  const [user, setUser] = useState<User | null>(auth.currentUser)
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [mine, setMine] = useState<Profile | null>(null)
  const [fields, setFields] = useState<Fields>(empty)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [register, setRegister] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)

  useEffect(() => onAuthStateChanged(auth, setUser), [])
  useEffect(() => {
    let active = true
    request('/api/profiles').then(data => { if (active) setProfiles(data.profiles || []) }).catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [refresh])
  useEffect(() => {
    let active = true
    setMine(null)
    setFields(empty)
    if (user) user.getIdToken().then(token => request('/api/profiles?scope=mine', { headers: { Authorization: `Bearer ${token}` } })).then(data => {
      if (active && data.profile) { setMine(data.profile); setFields({ displayName: data.profile.displayName, company: data.profile.company, className: data.profile.className, room: data.profile.room, floor: data.profile.floor }) }
    }).catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [user, refresh])

  async function authenticate(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('')
    try {
      if (register) await createUserWithEmailAndPassword(auth, email.trim(), password)
      else await signInWithEmailAndPassword(auth, email.trim(), password)
      setPassword('')
    } catch { setError('Não foi possível entrar. Confira e-mail e senha ou tente outra conta.') }
    finally { setBusy(false) }
  }

  async function save(event: FormEvent) {
    event.preventDefault(); if (!user) return
    setBusy(true); setError(''); setNotice('')
    try {
      const token = await user.getIdToken()
      const data = await request('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(fields) })
      setMine(data.profile); setNotice('Perfil público salvo.'); setRefresh(value => value + 1)
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível salvar.') }
    finally { setBusy(false) }
  }

  async function changePhoto(file: File | null) {
    if (!file || !user) return
    if (file.size > 2 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { setError('Escolha uma foto JPG, PNG ou WebP de até 2 MB.'); return }
    setBusy(true); setError(''); setNotice('')
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
      const token = await user.getIdToken()
      await request('/api/profile-photo', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'upload', base64: btoa(binary), mimeType: file.type }) })
      setNotice('Foto atualizada.'); setRefresh(value => value + 1)
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível enviar a foto.') }
    finally { setBusy(false) }
  }

  async function removePhoto() {
    if (!user) return
    setBusy(true); setError(''); setNotice('')
    try {
      const token = await user.getIdToken()
      await request('/api/profile-photo', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'remove' }) })
      setNotice('Foto removida.'); setRefresh(value => value + 1)
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível remover a foto.') }
    finally { setBusy(false) }
  }

  return <div className="profiles-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <section className="profiles-dialog" role="dialog" aria-modal="true" aria-labelledby="profiles-title">
      <header className="profiles-header"><div><small>COMUNIDADE</small><h2 id="profiles-title">Perfis</h2></div><button type="button" onClick={onClose} aria-label="Fechar perfis">×</button></header>
      <div className="profiles-body">
        <section className="profiles-edit">
          <h3>Meu perfil</h3>
          {!user ? <form onSubmit={authenticate} className="profiles-form">
            <p>Entre ou crie uma conta para publicar seu perfil. Qualquer pessoa poderá vê-lo nos dois sites.</p>
            <label>E-mail<input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" /></label>
            <label>Senha<input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} autoComplete={register ? 'new-password' : 'current-password'} /></label>
            <button type="submit" disabled={busy}>{register ? 'Criar conta' : 'Entrar'}</button>
            <button type="button" className="profiles-link" onClick={() => setRegister(!register)}>{register ? 'Já tenho conta' : 'Criar uma conta'}</button>
          </form> : <form onSubmit={save} className="profiles-form">
            <p className="profiles-account">{user.email} <button type="button" className="profiles-link" onClick={() => signOut(auth)}>Sair</button></p>
            <label>Nome<input value={fields.displayName} onChange={e => setFields({ ...fields, displayName: e.target.value })} maxLength={80} minLength={2} required /></label>
            <label>Empresa<input value={fields.company} onChange={e => setFields({ ...fields, company: e.target.value })} maxLength={100} /></label>
            <label>Turma<input value={fields.className} onChange={e => setFields({ ...fields, className: e.target.value })} maxLength={80} /></label>
            <div className="profiles-pair"><label>Sala<input value={fields.room} onChange={e => setFields({ ...fields, room: e.target.value })} maxLength={80} /></label><label>Andar<input value={fields.floor} onChange={e => setFields({ ...fields, floor: e.target.value })} maxLength={30} /></label></div>
            <p>Ao salvar, nome, empresa, turma, sala, andar e foto ficarão públicos na Agenda e no Cadê o professor. Seu e-mail não será exibido.</p>
            <button type="submit" disabled={busy}>Publicar perfil</button>
            <div className="profiles-photo"><strong>Foto</strong>{mine?.photoUrl && <img src={mine.photoUrl} alt="Sua foto de perfil" />}
              <label className="profiles-file">{mine?.photoUrl ? 'Trocar foto' : 'Adicionar foto'}<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || !mine} onChange={e => { void changePhoto(e.target.files?.[0] || null); e.target.value = '' }} /></label>
              {mine?.photoUrl && <button type="button" className="profiles-link" disabled={busy} onClick={removePhoto}>Remover foto</button>}
              {!mine && <small>Publique o nome antes de enviar uma foto (até 2 MB).</small>}
            </div>
          </form>}
          {error && <p role="alert" className="profiles-error">{error}</p>}{notice && <p role="status" className="profiles-notice">{notice}</p>}
        </section>
        <section className="profiles-directory"><h3>Pessoas da comunidade</h3><p>Perfis que as pessoas escolheram publicar.</p>
          {profiles.length === 0 ? <p>Nenhum perfil publicado ainda.</p> : <div className="profiles-grid">{profiles.map(profile => <article key={profile.uid} className="profiles-card">
            {profile.photoUrl ? <img src={profile.photoUrl} alt="" /> : <span className="profiles-avatar">{profile.displayName.slice(0, 1).toUpperCase()}</span>}
            <div><strong>{profile.displayName}</strong><span>{[profile.company, profile.className].filter(Boolean).join(' · ')}</span><small>{[profile.room && `Sala ${profile.room}`, profile.floor && `Andar ${profile.floor}`].filter(Boolean).join(' · ')}</small></div>
          </article>)}</div>}
        </section>
      </div>
    </section>
  </div>
}
