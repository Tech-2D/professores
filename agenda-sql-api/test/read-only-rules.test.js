import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {readOnlyRules} from '../src/read-only-rules.js'
const wrap=body=>"rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { "+body+' } }'
test('read-only conversion preserves exact read conditions and blocks every write operation',()=>{
  const input=wrap("allow get, list: if signedIn(); allow read, write: if owner('quoted;value'); allow create, update, delete: if true;")
  const result=readOnlyRules(input)
  assert.equal(result.readStatements,2);assert.equal(result.blockedWriteStatements,2)
  assert.ok(result.source.includes("allow read: if owner('quoted;value');"))
  assert.ok(result.source.includes('allow get, list: if signedIn();'))
  assert.ok(result.source.includes('allow write: if false;'))
})
test('comments and escaped quoted strings cannot inject an allow statement',()=>{
  const input=wrap("// allow write: if true;\n/* allow delete: if true; */ allow get: if text('allow read; \\'quoted'); allow update: if false;")
  const result=readOnlyRules(input)
  assert.equal(result.readStatements,1);assert.equal(result.blockedWriteStatements,1)
})
test('invalid or unknown statements fail closed rather than guessing',()=>{
  for(const input of [wrap('allow unknown: if true;'),wrap('allow get,: if true;'),wrap('allow write: if true'),wrap('/* unfinished')])assert.throws(()=>readOnlyRules(input))
})
test('current deployed project policy can be converted without changing any read declaration',async()=>{
  // Repository fixture, not a network call and no production rule deployment.
  const rules=await readFile(new URL('../../firestore.rules',import.meta.url),'utf8')
  const result=readOnlyRules(rules)
  assert.ok(result.readStatements>10);assert.ok(result.blockedWriteStatements>10)
  assert.equal(readOnlyRules(result.source).source,result.source)
})
