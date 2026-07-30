export const onRequest: PagesFunction = async (context) => {
  const path = (context.params.path as string[]).join('/');
  const url = `https://xiaohebo-catalog-beta.onrender.com/api/${path}`;
  const incoming = context.request;
  const searchParams = new URL(incoming.url).search;
  const resp = await fetch(`${url}${searchParams}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json',
    },
  });
  const body = await resp.text();
  return new Response(body, {
    status: resp.status,
    headers: {
      'Content-Type': resp.headers.get('Content-Type') || 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
};
