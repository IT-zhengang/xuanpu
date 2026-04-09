import { render as rtlRender, RenderOptions } from '@testing-library/react'
import { ReactElement } from 'react'

function render(ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  return rtlRender(ui, { ...options })
}

// eslint-disable-next-line react-refresh/only-export-components
export * from '@testing-library/react'
export { render }
