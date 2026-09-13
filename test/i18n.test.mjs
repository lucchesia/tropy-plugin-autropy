// What Autropy writes into a project is in the researcher's working language.
//
// Only what it WRITES — the provenance header on a note. The panel's controls
// stay in English: they are this tool's interface, not part of the record. An
// English stamp on a Portuguese summary is a machine announcing that it was
// built somewhere else, and it is the first thing a colleague reads.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { TRANSLATED_LANGUAGES, languageCode, noteStrings } from '../src/i18n.js'

const source = () => readFileSync(
  fileURLToPath(new URL('../src/plugin.js', import.meta.url)), 'utf8')

test('the option is free text, so spellings and accents all resolve', () => {
  // A researcher types what comes to mind. "Português", "portuguese" and "pt"
  // are the same request, and an accent must not silently mean English.
  for (const name of ['Portuguese', 'português', 'Português', 'pt', 'pt-BR',
    'Brazilian Portuguese', 'PORTUGUES']) {
    assert.equal(languageCode(name), 'pt', name)
  }

  assert.equal(languageCode('Español'), 'es')
  assert.equal(languageCode('français'), 'fr')
  assert.equal(languageCode('Italiano'), 'it')
  assert.equal(languageCode('Deutsch'), 'de')
})

test('blank means English, and so does a language nobody translated', () => {
  // Machine-translating the header would make the one part of the note that
  // must be exact the one part nobody checked.
  assert.equal(languageCode(''), 'en')
  assert.equal(languageCode(null), 'en')
  assert.equal(languageCode('Klingon'), 'en')
  assert.equal(languageCode('Japanese'), 'en')
})

test('every translation carries every string the header needs', () => {
  // A missing key would render "undefined" into a researcher's note.
  const keys = Object.keys(noteStrings('en'))

  for (const code of [...TRANSLATED_LANGUAGES, 'zzz-unknown']) {
    const t = noteStrings(code)
    for (const key of keys) {
      assert.ok(t[key], `${code} is missing ${key}`)
    }
  }
})

test('the counted strings are functions of the count, not fixed text', () => {
  assert.match(noteStrings('pt').fromPages(8), /8/)
  assert.match(noteStrings('pt').withContext(3), /3/)
  assert.match(noteStrings('pt').generated('2026-09-13 17:05', 'gemini-2.5-flash'),
    /2026-09-13 17:05.*gemini-2\.5-flash/)
})

test('Portuguese reads as Portuguese, not as a translated English sentence', () => {
  const t = noteStrings('Português')

  assert.match(t.itemMulti, /Resumo do item gerado por máquina/)
  assert.match(t.page, /Resumo da página gerado por máquina/)
  assert.match(t.withoutTranscription, /não havia transcrição/)
})

test('the header is composed from the table, never by the model', () => {
  // A provenance claim written by the thing whose provenance it records is a
  // suggestion, not a claim.
  const src = source()

  assert.match(src, /const t = noteStrings\(run\.outputLanguage\)/)
  assert.doesNotMatch(src, /'Machine-generated page summary'/)
})

test('the language is carried on the run, not read at write time', () => {
  // The preference can change between the analysis and the Apply. A stamp in a
  // language the summary is not in would be worse than either alone.
  assert.match(source(), /run\.outputLanguage = outputLanguage/)
})

test('one toolbar icon, however many instances are configured', () => {
  // Tropy constructs one plugin object per instance in Preferences, and each
  // injected its own button: two configured models, two identical icons.
  const src = source()

  assert.match(src, /if \(document\.getElementById\('autropy-toggle'\)\) \{/)
  assert.match(src, /another Autropy instance already owns the toolbar icon/)
})
