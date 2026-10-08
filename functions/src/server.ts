import { createServer } from 'node:http';
import { registerRoutes } from './dispatch';
import { invokeHandler, routeName, sendExportFile, type Handler } from './http';
import { routes } from './routes';

registerRoutes(routes);

export type { Handler };

const port = Number(process.env.PORT || 8787);

createServer(async (req, res) => {
  if (sendExportFile(req, res)) return;

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const name = routeName(url.pathname);
  const baseName = name.split('/')[0] || '';

  if (req.method === 'GET' && (baseName === '' || baseName === 'health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const handler = routes[baseName];
  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Função "${name || baseName}" não encontrada.` }));
    return;
  }

  await invokeHandler(req, res, handler);
}).listen(port, () => {
  console.log(`Servidor de funções em http://localhost:${port}`);
});
