import { readFile } from 'node:fs/promises'

const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const version = packageMetadata.version
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME

if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`package.json has an invalid release version: ${String(version)}`)
}
if (typeof tag !== 'string' || tag.length === 0) {
  throw new Error('release tag is required as an argument or GITHUB_REF_NAME')
}
if (tag !== `v${version}`) {
  throw new Error(`release tag ${JSON.stringify(tag)} must equal v${version}`)
}

process.stdout.write(`release identity verified: dsh-repro-kit@${version} (${tag})\n`)
