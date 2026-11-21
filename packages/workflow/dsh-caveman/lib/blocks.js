import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
async function callHook(binary, input, signal) {
    if (signal.aborted)
        return undefined;
    return new Promise(resolveHint => {
        const child = spawn(binary, ['hook', '--harness', 'generic', '--phase', 'pre'], {
            cwd: input.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
        });
        let output = '';
        let settled = false;
        const finish = (hint) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            resolveHint(hint);
        };
        const abort = () => { child.kill('SIGKILL'); finish(); };
        const timer = setTimeout(abort, 2500);
        signal.addEventListener('abort', abort, { once: true });
        child.on('error', () => finish());
        child.stdin.on('error', () => { });
        child.stdout.on('data', chunk => {
            output += String(chunk);
            if (output.length > 16384)
                abort();
        });
        child.once('close', code => {
            if (code !== 0 || signal.aborted || output.length > 16384)
                return finish();
            try {
                const result = JSON.parse(output);
                if (typeof result !== 'object' || result === null || !('protocol' in result) || result.protocol !== 1 ||
                    !('action' in result) || result.action !== 'allow' || !('hint' in result) || typeof result.hint !== 'string' ||
                    !result.hint || result.hint.length > 2000 || /[\r\n]/u.test(result.hint))
                    return finish();
                finish(result.hint);
            }
            catch {
                finish();
            }
        });
        child.stdin.end(JSON.stringify({ protocol: 1, phase: 'pre', harness: 'dsh', ...input, output: null }));
    });
}
/** Invoke the generic Blocks hook before shell dispatch; never change the command. */
export function registerBlocks(ctx, binary) {
    if (!isAbsolute(binary))
        throw new Error('dsh-caveman: blocksBinary must be an absolute path');
    ctx.on('tools/execute', async (exec, next) => {
        if ((exec.name !== 'bash' && exec.name !== 'pwsh') || !exec.agent ||
            typeof exec.arguments !== 'object' || exec.arguments === null || !('command' in exec.arguments) ||
            typeof exec.arguments.command !== 'string')
            return next();
        let hint;
        try {
            const directory = ctx.get('workingDirectory');
            const base = directory ? await directory.ensure(exec.agent, exec.signal) : exec.agent.session.header.cwd;
            if (base && isAbsolute(base)) {
                const requested = 'workdir' in exec.arguments && typeof exec.arguments.workdir === 'string' ? exec.arguments.workdir : '.';
                hint = await callHook(binary, {
                    cwd: resolve(base, requested), command: exec.arguments.command,
                    session: String(exec.agent.session.id), call_id: String(exec.callId),
                }, exec.signal);
            }
        }
        catch { /* A missing or failing hook must not change shell execution. */ }
        const result = await next();
        if (!hint || exec.signal.aborted)
            return result;
        const context = createUserMessage({
            source: { kind: 'dsh-caveman-blocks', form: 'notice', summary: 'Blocks suggestion' },
            content: [{ type: 'text', text: hint }],
        });
        return { ...result, additionalContexts: [...result.additionalContexts ?? [], context] };
    });
}
