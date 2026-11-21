import { createServer } from 'node:http'

export async function startMockMcp({ token = 'testtoken', initializeDelay = 0, duplicate = false, structured = false, structuredOnly = false, scopeChallenge = false, contentAnnotations = false, largeText = 0, workflowRefusal = false } = {}) {
  const requests = []
  const calls = []
  const state = { clientInfo: undefined }
  let origin
  const definitions = [
    { name: 'get_file_contents', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, annotations: { readOnlyHint: true } },
    { name: 'push_files', description: 'Push files', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false } },
    { name: 'unknown_tool', description: 'No safety hint', inputSchema: { type: 'object', properties: {} } },
  ]
  if (structured) definitions.push({ name: 'structured', inputSchema: { type: 'object', properties: { bad: { type: 'boolean' } } }, outputSchema: { type: 'object', properties: { ok: { type: 'boolean' }, count: { type: 'number' } }, required: ['ok'] }, annotations: { readOnlyHint: true } })
  if (duplicate) definitions.push(definitions[0])
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, authorization: req.headers.authorization, toolsets: req.headers['x-mcp-toolsets'], readOnly: req.headers['x-mcp-readonly'] })
    const supplied = req.headers.authorization?.replace(/^Bearer /, '')
    if (!(Array.isArray(token) ? token.includes(supplied) : supplied === token)) { res.writeHead(401).end(); return }
    if (req.method === 'DELETE') { res.writeHead(204).end(); return }
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const message = JSON.parse(Buffer.concat(chunks).toString())
    if (scopeChallenge && supplied === 'oldtoken' && message.method === 'tools/call' && message.params.name === 'push_files') {
      res.writeHead(403, { 'www-authenticate': 'Bearer error="insufficient_scope", scope="repo workflow"' }).end('Additional scope required')
      return
    }
    if (scopeChallenge && supplied === 'newtoken' && message.method === 'tools/call' && message.params.name === 'unknown_tool') {
      res.writeHead(403, { 'www-authenticate': 'Bearer error="insufficient_scope", scope="notifications"' }).end('Additional scope required')
      return
    }
    if (message.id === undefined) { res.writeHead(202).end(); return }
    let result
    if (message.method === 'initialize') {
      state.clientInfo = message.params.clientInfo
      if (initializeDelay) await new Promise((resolve) => setTimeout(resolve, initializeDelay))
      result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'github-mock', version: '1' } }
    } else if (message.method === 'tools/list') result = { tools: definitions }
    else if (message.method === 'tools/call') {
      calls.push({ name: message.params.name, arguments: message.params.arguments })
      result = workflowRefusal && message.params.name === 'push_files'
        ? { isError: true, content: [{ type: 'text', text: 'refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope' }] }
        : message.params.name === 'structured'
        ? { content: structuredOnly ? [] : [{ type: 'text', text: 'structured' }], structuredContent: { ok: message.params.arguments?.bad ? 'invalid' : true, count: 1 } }
        : message.params.arguments?.path === 'fail'
        ? { isError: true, content: [{ type: 'text', text: `Permission denied for ${supplied}` }] }
        : { content: [{ type: 'text', text: largeText ? `${'x'.repeat(largeText)} ${supplied}` : `Read ${message.params.arguments?.path ?? 'file'} ${supplied}` }] }
    } else { res.writeHead(400).end(); return }
    if (contentAnnotations && message.method === 'tools/call' && result.content?.[0]) result.content[0].annotations = { priority: 1 }
    if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  return { url: `${origin}/mcp`, requests, calls, state, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }) }
}
