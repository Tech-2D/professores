import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { X509Certificate } from 'node:crypto'
import { parseArgs, parseEnv } from 'node:util'
import { ACCOUNT, NAME, cloudflareClient, confirmAccount, configuration, verifyConfiguration } from './cloudflare-connection.js'
import { reportFailure } from './connection.js'

try {
  const { values } = parseArgs({ options: { execute: { type: 'boolean', default: false } } })
  if (!values.execute) console.log('Preparado para Hyperdrive com usuário limitado, TLS verify-full, cinco conexões e cache desativado. Use --execute somente após autorizar a conta Tech-2D.')
  else {
    const api = await cloudflareClient()
    await confirmAccount(api)
    console.log('Acesso à conta Cloudflare Tech-2D confirmado antes do envio de qualquer credencial SQL.')
    // No database credential is even read until the correct Cloudflare account is confirmed.
    const values = parseEnv(await readFile(new URL('../../firebase-credentials/aiven-runtime.env', import.meta.url), 'utf8'))
    const origin = new URL(values.DATABASE_URL)
    const certificate = await readFile(new URL('../../firebase-credentials/aiven-ca.pem', import.meta.url), 'utf8')
    const fingerprint = new X509Certificate(certificate).fingerprint256
    const base = `/accounts/${ACCOUNT}`
    const all = await api(base + '/mtls_certificates')
    const matches = all.filter(item => item.name === 'tech2d-aiven-ca')
    if (matches.length > 1) throw new Error('CERTIFICATE_REVIEW_REQUIRED')
    let ca = matches[0]
    if (ca) {
      const detail = await api(base + `/mtls_certificates/${ca.id}`)
      if (!detail.ca || typeof detail.certificates !== 'string' || new X509Certificate(detail.certificates).fingerprint256 !== fingerprint) throw new Error('CERTIFICATE_REVIEW_REQUIRED')
    } else ca = await api(base + '/mtls_certificates', 'POST', { name: 'tech2d-aiven-ca', certificates: certificate, ca: true })
    const expected = configuration(origin, ca.id)
    const configs = await api(base + '/hyperdrive/configs')
    const named = configs.filter(item => item.name === NAME)
    if (named.length > 1) throw new Error('HYPERDRIVE_REVIEW_REQUIRED')
    const resource = named[0]
      ? await api(base + `/hyperdrive/configs/${named[0].id}`)
      : await api(base + '/hyperdrive/configs', 'POST', expected)
    verifyConfiguration(resource, expected)
    await mkdir('.wrangler', { recursive: true })
    await writeFile('.wrangler/sql-connection.json', JSON.stringify({ account: ACCOUNT, hyperdriveId: resource.id, certificateId: ca.id, tls: 'verify-full', cachingDisabled: true, connectionLimit: 5 }, null, 2) + '\n')
    console.log(`Conexão Hyperdrive validada na conta Tech-2D. ID do binding: ${resource.id}`)
    console.log('Certificado verificado; cache desligado; usuário exclusivo; limite de cinco conexões. Nenhuma senha foi enviada em argumentos ou gravada em logs.')
  }
} catch (error) { reportFailure(error) }
