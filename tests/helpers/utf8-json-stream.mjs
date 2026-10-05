/** Test-only loopback bridge. Never decode individual HTTP Buffer chunks. */
export async function readUtf8Json(stream) {
  const chunks=[];
  for await (const chunk of stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
