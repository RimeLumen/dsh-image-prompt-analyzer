
function renderValueAsText(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function registerTool(ctx, spec) {
  const definition = {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: spec.outputSchema ?? { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderValueAsText(value) }],
      // 模型读的是 render 出来的文本；浏览器半侧读的是持久化的 block.meta。
      // 只有显式声明 presentationMeta 的工具才往 meta 里写东西，其余工具保持原样。
      ...(typeof spec.presentationMeta === 'function'
        ? { presentationMeta: (args, value) => spec.presentationMeta(args ?? {}, value) }
        : {}),
    },
    execute: async (args, exec) => spec.execute(args ?? {}, exec ?? {}),
  }
  return ctx.tools.register(definition)
}
