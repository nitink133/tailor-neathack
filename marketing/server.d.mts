import type { Server } from 'node:http';
export function createWebsiteServer(options?: {demoOrigin?: string; demoEntryPath?: string; publicOrigin?: string | null}): Server;
