/** Loads Testing Library only after the DOM exists (react-dom checks for a DOM when it first loads). */
import './dom'

const rtl = await import('@testing-library/react')

export const { cleanup, fireEvent, render, screen, waitFor, within } = rtl
