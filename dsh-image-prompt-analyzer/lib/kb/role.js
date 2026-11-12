/**
 * 数据源的角色。
 *
 * 一个源是"词表"还是"词典"，决定了它能干什么：
 *
 *   model       这个词能不能进提示词，由它判定。Illustrious / Anima 的标签表属于这一类。
 *   supplement  只解释、只检索、只提供中文名与别名，不参与"这个词有效吗"的判定。
 *               工作室词典与随包发布的中文对照表都属于这一类。
 *
 * 早期版本靠 type 推断（local_file → model，studio_sqlite → supplement）。
 * 随包中文对照表是 local_file，却应该是 supplement，所以 2.3 起改成显式声明：
 * 配置里写了 role 就用配置的，没写就看 source_meta 里导入时记下的，
 * 再没有才按 type 回退。三层顺序保证旧配置与旧库升级后行为不变。
 */

export const SOURCE_ROLES = Object.freeze({
  MODEL: 'model',
  SUPPLEMENT: 'supplement',
})

export const MODEL_SOURCE_TYPES = Object.freeze(['local_file', 'local_sqlite'])
export const SUPPLEMENT_SOURCE_TYPES = Object.freeze(['studio_sqlite'])

/** 没有显式声明时，按源类型给出的默认角色。 */
export function defaultRoleForType(type) {
  const value = String(type ?? 'local_file')
  if (SUPPLEMENT_SOURCE_TYPES.includes(value)) return SOURCE_ROLES.SUPPLEMENT
  if (MODEL_SOURCE_TYPES.includes(value)) return SOURCE_ROLES.MODEL
  return SOURCE_ROLES.MODEL
}

/**
 * 把 source_meta 里的 role 读成一张表。读不到就返回空表——
 * 老库没有这一列、或 handle 还没打开，都不该让建库失败。
 */
export function readStoredRoles(handle) {
  const roles = new Map()
  if (!handle || typeof handle.all !== 'function') return roles
  try {
    for (const row of handle.all('SELECT source_id, role FROM source_meta')) {
      if (row?.role) roles.set(String(row.source_id), String(row.role))
    }
  } catch {
    // 列不存在（未迁移的旧库）或句柄只读异常：按 type 回退即可。
  }
  return roles
}

/**
 * 给配置里的每个源定角色，返回 Map<source_id, role>。
 * 顺序：配置显式 role → 导入时记录的 role → 按 type 推断。
 */
export function resolveSourceRoles(sources = [], { handle = null } = {}) {
  const stored = readStoredRoles(handle)
  const roles = new Map()
  for (const source of sources) {
    const sourceId = String(source?.source_id ?? '')
    if (!sourceId) continue
    const declared = source?.role ? String(source.role) : null
    const recorded = stored.get(sourceId) ?? null
    roles.set(sourceId, declared ?? recorded ?? defaultRoleForType(source?.type))
  }
  return roles
}

export function isSupplementRole(role) {
  return role === SOURCE_ROLES.SUPPLEMENT
}
