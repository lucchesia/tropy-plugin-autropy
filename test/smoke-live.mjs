// Read-only smoke test against a RUNNING Tropy.
//
// Not part of `npm test` — it needs a live Tropy and a real project, so it is
// run by hand. It performs GETs only: nothing is written.
//
//   node test/smoke-live.mjs "/path/to/Your Project.tropy" [port]
//
// Find the path with:  curl -s http://localhost:2029/ | python3 -m json.tool
//
// What it proves that the unit tests cannot: that urlId matches what Tropy
// actually derives from a real filename (including spaces and punctuation),
// that the identity comparison succeeds against the live response, and that a
// deliberately wrong project path fails closed.

import { ProjectIdentityError, RestProjectGateway, urlId } from '../src/gateway.js'

const projectPath = process.argv[2]
const port = Number(process.argv[3]) || 2029

if (!projectPath) {
  console.error('usage: node test/smoke-live.mjs "/path/to/Project.tropy" [port]')
  process.exit(2)
}

const logger = {
  warn: (...args) => console.log('   ', ...args),
  error: (...args) => console.error('   ', ...args)
}

let failures = 0
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures += 1
}

console.log(`project: ${projectPath}`)
console.log(`urlId  : ${urlId(projectPath)}\n`)

const gateway = new RestProjectGateway({ projectPath, port, logger })

const resolved = await gateway.resolve()
check('resolve() verified the project', resolved.projectPath === projectPath)
check('route shape detected', Boolean(resolved.shape), `${resolved.shape} → ${resolved.base}`)
check('Tropy version reported', Boolean(resolved.version), resolved.version || 'none')
check('base never targets /project/current', !resolved.base.includes('/project/current'))

const tags = await gateway.getTags()
check('getTags() returned an array', Array.isArray(tags), `${tags.length} tag(s)`)

// Any item id present in the project; the first one keeps this generic.
const items = await fetch(`${resolved.base}/items`).then(r => r.json())
const itemId = items[0]?.id

if (itemId) {
  const metadata = await gateway.getMetadata(itemId)
  check(`getMetadata(${itemId}) returned an object`, metadata && typeof metadata === 'object',
    Object.keys(metadata).join(', ') || 'no fields')
}

await gateway.assertWriteTarget()
check('assertWriteTarget() passed on a fresh probe', true)

// The important negative: a path that is not this project must be refused.
const wrong = new RestProjectGateway({
  projectPath: '/tmp/Definitely Not This Project.tropy',
  port,
  logger: { warn () {}, error () {} }
})

try {
  await wrong.resolve()
  check('a wrong project path is refused', false, 'it was ACCEPTED — identity check is broken')
} catch (err) {
  check('a wrong project path is refused', err instanceof ProjectIdentityError, err.name)
}

console.log(failures === 0 ? '\nall live checks passed' : `\n${failures} live check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
