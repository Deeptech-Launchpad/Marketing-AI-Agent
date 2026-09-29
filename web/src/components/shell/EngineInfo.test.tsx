import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../../lib/theme'
import { ENGINES, SETTINGS_TOOLS } from '../../lib/engines'
import { ENGINE_HELP } from '../../lib/engineHelp'
import { EnginePage } from './EnginePage'

// Every engine header carries an (i) that says, in plain words, what the
// engine does and what to do next (2026-09-29).

const all = [...ENGINES, ...SETTINGS_TOOLS]

describe('the engine Info button', () => {
  it('has short help for every engine with a header', () => {
    for (const e of all) {
      const help = ENGINE_HELP[e.id]
      expect(help, e.id).toBeTruthy()
      expect(help!.what.length).toBeGreaterThan(40)
      expect(help!.next).toBeTruthy()
    }
  })

  for (const e of all) {
    it(`opens the ${e.title} explanation from its header`, async () => {
      render(
        <ThemeProvider>
          <MemoryRouter>
            <EnginePage engineId={e.id}>
              <p>body</p>
            </EnginePage>
          </MemoryRouter>
        </ThemeProvider>,
      )
      await userEvent.click(screen.getByRole('button', { name: `What is ${e.title}?` }))
      const note = screen.getByRole('note')
      expect(note.textContent).toContain(ENGINE_HELP[e.id]!.what)
      expect(note.textContent).toMatch(/Next:/)
    })
  }
})
