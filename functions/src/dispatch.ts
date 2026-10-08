import type { Handler } from './http';

const handlers = new Map<string, Handler>();

export function registerRoutes(routes: Record<string, Handler>): void {
  for (const [name, handler] of Object.entries(routes)) handlers.set(name, handler);
}

export function registeredHandler(name: string): Handler | undefined {
  const route = name.replace(/^\//, '').split('?')[0].split('/')[0];
  return handlers.get(route);
}
