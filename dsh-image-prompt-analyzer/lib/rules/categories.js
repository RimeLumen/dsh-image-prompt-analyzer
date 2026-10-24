
import { readFileSync } from 'node:fs'

const DATA = JSON.parse(readFileSync(new URL('../../configs/categories.json', import.meta.url), 'utf8'))

export const INTERNAL_CATEGORIES = Object.freeze(DATA.internal_categories)

export const CATEGORY_IDS = new Set(INTERNAL_CATEGORIES.map((item) => item.category_id))

export const POSITIVE_LAYERS = Object.freeze(DATA.positive_layers)

export const DEFAULT_POSITIVE_ORDER = Object.freeze(DATA.default_positive_order)

export const MUST_KEEP_CATEGORIES = Object.freeze(DATA.must_keep_categories)

export function layerOf(categoryId) {
  const found = INTERNAL_CATEGORIES.find((item) => item.category_id === categoryId)
  return found ? found.layer : 0
}
