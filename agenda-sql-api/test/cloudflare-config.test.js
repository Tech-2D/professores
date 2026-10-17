import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACCOUNT, NAME, confirmAccount, configuration, verifyConfiguration } from '../scripts/cloudflare-connection.js'

test('wrong account prevents proceeding to credential transmission', async () => {
  const requests = []
  await assert.rejects(() => confirmAccount(async path => { requests.push(path); return { id: 'other' } }), /WRONG_CLOUDFLARE_ACCOUNT/)
  assert.deepEqual(requests, [`/accounts/${ACCOUNT}`])
})

test('correct account confirmation is explicit', async () => {
  await confirmAccount(async () => ({ id: ACCOUNT }))
})

test('owner credentials cannot become a Hyperdrive origin', () => {
  assert.throws(() => configuration(new URL('postgres://avnadmin:example@host/db'), 'ca'), /SQL_RUNTIME_CREDENTIAL_REQUIRED/)
})

test('Hyperdrive enforces verified TLS, pooling ceiling and no cached SQL', () => {
  const config = configuration(new URL('postgres://tech2d_api:example@host:1234/db'), 'ca')
  assert.equal(config.name, NAME)
  assert.equal(config.origin.password, 'example')
  assert.equal(config.caching.disabled, true)
  assert.equal(config.origin_connection_limit, 5)
  assert.equal(config.mtls.sslmode, 'verify-full')
  verifyConfiguration(config, config)
  assert.throws(() => verifyConfiguration({ ...config, caching: { disabled: false } }, config))
  assert.throws(() => verifyConfiguration({ ...config, origin_connection_limit: 20 }, config))
  assert.throws(() => verifyConfiguration({ ...config, mtls: { ...config.mtls, sslmode: 'require' } }, config))
})
