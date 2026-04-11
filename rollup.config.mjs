import { join } from 'node:path'
import license from 'rollup-plugin-license'
import resolve from '@rollup/plugin-node-resolve'
import json from '@rollup/plugin-json'

export default {
  input: 'src/plugin.js',
  output: {
    file: 'index.js',
    format: 'cjs',
    generatedCode: 'es2015'
  },
  external: [
    'electron'
  ],
  plugins: [
    json(),
    resolve({
      exportConditions: ['node'],
      preferBuiltins: true
    }),
    license({
      thirdParty: {
        includePrivate: true,
        output: {
          file: join(import.meta.dirname, 'third-party-licenses.txt')
        }
      }
    })
  ]
}
