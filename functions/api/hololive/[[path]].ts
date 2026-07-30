export const onRequest: PagesFunction = async (context) => {
  const path = (context.params.path as string[]).join('/');
  const url = `https://shop.hololivepro.com/${path}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json, text/html, */*',
    },
  });
  const body = await resp.text();
  return new Response(body, {
    status: resp.status,
    headers: {
      'Content-Type': resp.headers.get('Content-Type') || 'text/html',
      'Access-Control-Allow-Origin': '*',
    },
  });
};
