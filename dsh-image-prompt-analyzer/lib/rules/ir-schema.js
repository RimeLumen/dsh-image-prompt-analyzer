
import { readFileSync } from 'node:fs'

export const IMAGE_TYPE_CODE_PATTERN = /^T[0-6]-[A-Z0-9]{2,3}$/

const DATA = JSON.parse(readFileSync(new URL('../../configs/uncertainty-codes.json', import.meta.url), 'utf8'))

export const UNCERTAINTY_CODES = Object.freeze(DATA.uncertainty_codes)
