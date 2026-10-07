import { expect, test } from 'claude-code/testing'

import { themeCss } from './graph'

const token = (css: string, name: string) => css.match(new RegExp(`--${name}:(#[0-9a-f]+)`))?.[1]

test('a light or dark theme is drawn as set, whatever the system prefers', () => {
  for (const theme of ['dark', 'light', 'dark-daltonized', 'light-ansi']) {
    expect(themeCss(theme)).not.toContain('prefers-color-scheme')
  }
  expect(token(themeCss('dark'), 'bg')).not.toBe(token(themeCss('light'), 'bg'))
})

test('auto, or a theme name we do not know, follows the system', () => {
  for (const theme of ['auto', 'solarized']) {
    expect(themeCss(theme)).toContain('prefers-color-scheme: dark')
  }
})

test('the colour-blind themes stop telling done from failed by green against red', () => {
  for (const base of ['light', 'dark']) {
    const plain = themeCss(base)
    const dalton = themeCss(`${base}-daltonized`)
    expect(token(dalton, 'ok')).not.toBe(token(plain, 'ok'))
    expect(token(dalton, 'bad')).not.toBe(token(plain, 'bad'))
    expect(token(dalton, 'run')).not.toBe(token(dalton, 'ok'))
  }
})
