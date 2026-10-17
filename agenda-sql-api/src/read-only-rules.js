// Lex only the rule statements: quoted strings and comments must never become code.
function tokens(source) {
  const result=[]
  for(let i=0;i<source.length;) {
    if(/\s/.test(source[i])) {i++;continue}
    if(source.startsWith('//',i)) {const end=source.indexOf('\n',i);i=end<0 ? source.length : end+1;continue}
    if(source.startsWith('/*',i)) {const end=source.indexOf('*/',i+2);if(end<0)throw Error('INVALID_RULE_COMMENT');i=end+2;continue}
    const start=i
    if(source[i]==='"' || source[i]==="'") {
      const quote=source[i++];let closed=false
      while(i<source.length) {if(source[i]==='\\'){i+=2;continue}if(source[i++]===quote){closed=true;break}}
      if(!closed)throw Error('INVALID_RULE_STRING')
    } else if(/[A-Za-z_]/.test(source[i])) {while(i<source.length && /[A-Za-z0-9_]/.test(source[i]))i++}
    else i++
    result.push({text:source.slice(start,i),start,end:i})
  }
  return result
}
const reads=new Set(['read','get','list']),writes=new Set(['write','create','update','delete'])
function statements(source) {
  const lex=tokens(source),result=[]
  for(let i=0;i<lex.length;i++) {
    if(lex[i].text!=='allow')continue
    const start=i,names=[];let expectName=true
    for(i++;i<lex.length && lex[i].text!==':';i++) {
      if(expectName) {if(!reads.has(lex[i].text)&&!writes.has(lex[i].text))throw Error('UNKNOWN_RULE_OPERATION');names.push(lex[i].text)}
      else if(lex[i].text!==',')throw Error('INVALID_RULE_OPERATION_LIST')
      expectName=!expectName
    }
    if(!names.length || expectName || lex[i+1]?.text!=='if')throw Error('INVALID_ALLOW_STATEMENT')
    const conditionStart=lex[++i].end,condition=[]
    for(i++;i<lex.length && lex[i].text!==';';i++)condition.push(lex[i].text)
    if(lex[i]?.text!==';' || !condition.length)throw Error('INVALID_ALLOW_CONDITION')
    result.push({names,start:lex[start].start,end:lex[i].end,expression:source.slice(conditionStart,lex[i].start).trim(),condition})
  }
  return result
}
const readSignatures=rows=>rows.filter(r=>r.names.some(n=>reads.has(n))).map(r=>JSON.stringify([r.names.filter(n=>reads.has(n)),r.condition]))
export function readOnlyRules(source) {
  if(typeof source!=='string' || !source.includes('service cloud.firestore'))throw Error('FIRESTORE_RULES_REQUIRED')
  const before=statements(source)
  if(!before.length || !before.some(r=>r.names.some(n=>writes.has(n))))throw Error('WRITE_RULES_NOT_FOUND')
  let output=source
  for(const row of [...before].reverse()) {
    if(!row.names.some(n=>writes.has(n)))continue
    const read=row.names.filter(n=>reads.has(n)),write=row.names.filter(n=>writes.has(n))
    const replacement=(read.length ? 'allow '+read.join(', ')+': if '+row.expression+';\n' : '')+'allow '+write.join(', ')+': if false;'
    output=output.slice(0,row.start)+replacement+output.slice(row.end)
  }
  const after=statements(output)
  if(JSON.stringify(readSignatures(before))!==JSON.stringify(readSignatures(after)))throw Error('READ_PERMISSIONS_CHANGED')
  if(after.some(r=>r.names.some(n=>writes.has(n)) && JSON.stringify(r.condition)!=='["false"]'))throw Error('WRITE_PERMISSION_REMAINING')
  return {source:output,readStatements:readSignatures(after).length,blockedWriteStatements:after.filter(r=>r.names.some(n=>writes.has(n))).length}
}
