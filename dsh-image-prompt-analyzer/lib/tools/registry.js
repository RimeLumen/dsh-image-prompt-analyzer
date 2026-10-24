
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
    },
    execute: async (args, exec) => spec.execute(args ?? {}, exec ?? {}),
  }
  return ctx.tools.register(definition)
}
