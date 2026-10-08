import { onRequest } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import { registerRoutes } from './dispatch';
import { GROUPS, groupOf, type GroupName } from './groups';
import { invokeHandler, routeName, sendExportFile } from './http';
import { routes } from './routes';

setGlobalOptions({
  region: 'southamerica-east1',
  invoker: 'public',
});

registerRoutes(routes);

function groupFunction(group: GroupName, timeoutSeconds: number) {
  const allowed = new Set<string>(GROUPS[group]);
  return onRequest({ timeoutSeconds, memory: '512MiB' }, async (req, res) => {
    if (group === 'api' && sendExportFile(req, res)) return;

    const url = new URL(req.originalUrl || req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const name = routeName(url.pathname);
    const baseName = name.split('/')[0] || '';
    const handler = routes[baseName];

    if (!handler || !allowed.has(baseName) || groupOf(baseName) !== group) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Rota "${baseName || name}" não pertence a ${group}.` }));
      return;
    }

    await invokeHandler(req, res, handler);
  });
}

export const api = groupFunction('api', 300);
export const payments = groupFunction('payments', 120);
export const webhooks = groupFunction('webhooks', 60);
export const jobs = groupFunction('jobs', 540);
