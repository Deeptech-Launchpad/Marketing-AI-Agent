import { Moon, Sun } from 'lucide-react'
import { useTheme, type Theme } from '../../lib/theme'

// The theme switch.
//
// Two states, one control, sitting with the other account-level actions in
// the top bar. It is a preference, not a feature, so it is easy to find and
// deliberately quiet — no settings screen stands between a viewer and it.

const OPTIONS: Array<{ value: Theme; label: string; Icon: typeof Sun }> = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
]

export function ThemeSwitch() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="themeswitch" role="group" aria-label="Colour theme">
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = theme === value
        return (
          <button
            key={value}
            type="button"
            className={`themeswitch__opt${active ? ' is-active' : ''}`}
            onClick={() => setTheme(value)}
            aria-pressed={active}
            title={`${label} theme`}
          >
            <Icon size={13} aria-hidden="true" />
            <span className="sr-only">{label} theme</span>
          </button>
        )
      })}
    </div>
  )
}
