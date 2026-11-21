/** Limit decoded response bytes before the MCP SDK buffers or parses them. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
// Error bodies only need to reach the SDK intact, not the whole streaming limit.
// Buffering an attacker-sized 16 MiB error page per failed call is pure waste;
// cap the copy while keeping the same reject-on-overflow behavior.
const MAX_BUFFERED_ERROR_BYTES = 1024 * 1024;
function limitStream(body, maxBytes, events, onLimit, onEvent) {
    let size = 0;
    let lineHasData = false;
    let lineStartSize = 0;
    let comment = false;
    let previousCR = false;
    let discardFollowingLF = false;
    const exceeded = () => {
        onLimit();
        throw new Error('github: MCP response exceeds the byte limit');
    };
    return body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            if (events) {
                let offset = 0;
                while (offset < chunk.length) {
                    // Scan and charge the next run together, stopping once it exceeds the
                    // remaining budget. This also covers chunks with no line separators.
                    const start = offset;
                    const end = Math.min(chunk.length, offset + maxBytes - size + 1);
                    while (offset < end && chunk[offset] !== 13 && chunk[offset] !== 10)
                        offset++;
                    if (offset > start) {
                        if (!lineHasData)
                            comment = chunk[start] === 58;
                        lineHasData = true;
                        previousCR = false;
                        size += offset - start;
                        if (size > maxBytes)
                            exceeded();
                    }
                    if (offset === chunk.length)
                        break;
                    const byte = chunk[offset++];
                    if (byte === 10 && previousCR) {
                        previousCR = false;
                        if (!discardFollowingLF && ++size > maxBytes)
                            exceeded();
                        lineStartSize = size;
                        continue;
                    }
                    if (++size > maxBytes)
                        exceeded();
                    // A blank line resets the event budget. A comment only rewinds its
                    // own bytes. Remember whether a following LF belongs to either line.
                    previousCR = byte === 13;
                    discardFollowingLF = !lineHasData || comment;
                    if (!lineHasData) {
                        onEvent?.();
                        size = 0;
                    }
                    else if (comment)
                        size = lineStartSize;
                    lineHasData = false;
                    comment = false;
                    lineStartSize = size;
                }
            }
            else {
                size += chunk.byteLength;
                if (size > maxBytes)
                    exceeded();
            }
            controller.enqueue(chunk);
        },
    }));
}
function copyResponse(source, body) {
    const response = new Response(body, { status: source.status, statusText: source.statusText, headers: source.headers });
    // OAuth discovery uses response.url to resolve relative redirect locations.
    Object.defineProperties(response, {
        url: { value: source.url },
        redirected: { value: source.redirected },
        type: { value: source.type },
    });
    return response;
}
export async function limitResponse(source, maxBytes, onLimit, onEvent) {
    if (!source.body)
        return source;
    // The SDK catches errors from response.text() on some authorization paths.
    // Read error responses here so an oversized body cannot be swallowed there.
    const redirect = source.status >= 300 && source.status < 400 && source.headers.has('location');
    if (!source.ok && !redirect) {
        const response = copyResponse(source, limitStream(source.body, Math.min(maxBytes, MAX_BUFFERED_ERROR_BYTES), false, onLimit));
        const bytes = await response.arrayBuffer();
        return copyResponse(source, bytes.byteLength ? bytes : null);
    }
    const events = source.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream';
    const response = copyResponse(source, limitStream(source.body, maxBytes, events, onLimit, onEvent));
    if (events) {
        // OAuth endpoints are parsed as a whole even if they claim to be SSE.
        // Whole-body consumers need a total limit in addition to the event limit.
        const wholeBody = () => {
            if (!response.body || response.bodyUsed)
                throw new TypeError('Response body is already used');
            return copyResponse(source, limitStream(response.body, maxBytes, false, onLimit));
        };
        Object.defineProperties(response, {
            json: { value: () => wholeBody().json() },
            text: { value: () => wholeBody().text() },
            arrayBuffer: { value: () => wholeBody().arrayBuffer() },
            bytes: { value: async () => new Uint8Array(await wholeBody().arrayBuffer()) },
            blob: { value: () => wholeBody().blob() },
            formData: { value: () => wholeBody().formData() },
        });
    }
    return response;
}
