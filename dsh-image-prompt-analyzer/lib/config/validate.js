
import { diagnostic, SEVERITY } from '../diagnostics.js'

const VALIDATE_CODES = Object.freeze({
  UNKNOWN_FIELD: 'CONFIG_UNKNOWN_FIELD',
  SCHEMA_VIOLATION: 'CONFIG_SCHEMA_VIOLATION',
  SCHEMA_PATTERN_INVALID: 'CONFIG_SCHEMA_PATTERN_INVALID',
})

export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze({
  'knowledge-base': Object.freeze(['2.0']),
  'model-profile': Object.freeze(['1.0']),
  preset: Object.freeze(['1.0']),
})

export const SEMANTIC_ROOTS = Object.freeze([
  '/storage',
  '/sources',
  '/lookup',
  '/categories',
  '/target',
  '/prompt',
  '/syntax',
  '/weight_policy',
  '/tag_mapping',
  '/variants',
  '/tag_rewrites',
  '/detail_density',
  '/suppression',
  '/must_keep_categories',
  '/category_priority_overrides',
  '/variant',
  '/schema_version',
  '/config_id',
])

export function isSemanticPath(fieldPath) {
  if (!fieldPath) return false
  return SEMANTIC_ROOTS.some((root) => fieldPath === root || fieldPath.startsWith(`${root}/`))
}

export function classifySchemaError(item, { config_file, strict_mode = false }) {
  if (item.keyword === 'schema') {
    return diagnostic({
      error_code: VALIDATE_CODES.SCHEMA_PATTERN_INVALID,
      severity: SEVERITY.ERROR,
      config_file,
      field_path: item.field_path,
      message: `${item.message}（这是插件包里的 schema 与当前代码不匹配，不是你的配置写错了）`,
      suggested_fix: '升级或重新安装插件；如果改过 configs/ 下的 schema，把它恢复成出厂版本。',
    })
  }
  const unknownField = item.keyword === 'additionalProperties'
  if (unknownField && !strict_mode && !isSemanticPath(item.field_path)) {
    return diagnostic({
      error_code: VALIDATE_CODES.UNKNOWN_FIELD,
      severity: SEVERITY.WARNING,
      config_file,
      field_path: item.field_path,
      message: `${item.message}（已忽略；本配置未开启 strict_mode）`,
      suggested_fix: '删掉该字段，或把它的拼写改成 schema 里的字段名；确认要保留时把 strict_mode 设为 true 并同步更新 schema。',
    })
  }
  return diagnostic({
    error_code: VALIDATE_CODES.SCHEMA_VIOLATION,
    severity: SEVERITY.ERROR,
    config_file,
    field_path: item.field_path,
    message: item.message,
    suggested_fix: '对照 configs/ 下的同名 schema 修正该字段。',
  })
}

export { crossValidateKnowledgeBase, crossValidatePreset, unsafeRelativePath } from './cross-validate.js'
