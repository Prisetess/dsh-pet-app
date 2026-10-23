/**
 * 本 App 的 HTTP 服务：一个 node:http 实例同时承载
 *   1. 插件自己的路由（前缀 /dsh-pet-7340，由 apply(ctx) 注册）；
 *   2. 宠物窗页面与静态资源（/pet-window/*）；
 *   3. 设置窗页面与静态资源（/pet-settings/*）；
 *   4. App 自己的控制端点（/pet-app/rebuild）。
 *
 * 为什么全部塞进同一个端口：页面里的 fetch 都是相对路径（插件设置页写死了 /dsh-pet-7340/...），
 * 同源就不需要改插件代码，也没有 CORS 问题。
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonc': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ico': 'image/x-icon',
};

const DEFAULT_PORT = 3080;
const PORT_SCAN_LIMIT = 25;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** 静态目录映射：URL 前缀 → 磁盘目录（首页缺省回落到 index.html） */
async function serveStatic(res, roots, pathname) {
  for (const [prefix, dir] of Object.entries(roots)) {
    if (!pathname.startsWith(prefix)) continue;
    let rel = pathname.slice(prefix.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    // 防目录穿越：resolve 后必须仍在 dir 内
    const target = path.resolve(dir, rel.replace(/^\/+/, ''));
    if (!target.startsWith(path.resolve(dir))) return false;
    try {
      const info = await stat(target);
      if (!info.isFile()) return false;
      res.writeHead(200, {
        'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
        'content-length': info.size,
        'cache-control': 'no-store',
      });
      createReadStream(target).pipe(res);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function matches(route, pathname) {
  if (route.kind === 'exact') return pathname === route.path;
  return pathname === route.path || pathname.startsWith(`${route.path}/`);
}

async function bindFirstFree(server, preferred, logger) {  for (let port = preferred; port < preferred + PORT_SCAN_LIMIT; port += 1) {
    try {
      await new Promise((accept, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          accept();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : port;
      if (preferred > 0 && bound !== preferred) logger.warn(`端口 ${preferred} 被占用，改用 ${bound}`);
      return bound;
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`从 ${preferred} 起连续 ${PORT_SCAN_LIMIT} 个端口都被占用`);
}

/**
 * @param {{
 *   routes: Array, logger: object, staticRoots: Record<string,string>,
 *   onRebuild?: () => unknown, status?: () => unknown, preferredPort?: number,
 * }} options
 */
export async function startServer(options) {
  const { routes, logger, staticRoots, onRebuild, autostart, stats, status, preferredPort = DEFAULT_PORT } = options;

  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    let pathname = '/';
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    } catch {
      /* 非法 URL 当首页处理 */
    }

    try {
      if (process.env.DSH_PET_DEBUG === '1') {
        logger.info(`${method} ${pathname} len=${req.headers['content-length'] ?? '?'}`);
      }
      if (method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*' });
        res.end();
        return;
      }
      if (pathname === '/' || pathname === '/health') {
        json(res, 200, status?.() ?? { name: 'dsh-pet-app' });
        return;
      }
      // App 自己的控制端点：设置页保存后立刻重建宠物窗（不用等文件监听）
      if (pathname === '/pet-app/rebuild') {
        if (method !== 'POST') {
          json(res, 405, { error: 'method not allowed' });
          return;
        }
        await onRebuild?.();
        json(res, 200, { ok: true });
        return;
      }
      // 开机自启：GET 读状态、POST {enabled} 写当前用户的 Run 键
      if (pathname === '/pet-app/autostart') {
        if (!autostart) {
          json(res, 501, { error: 'autostart not supported' });
          return;
        }
        if (method === 'GET') {
          json(res, 200, autostart.get());
          return;
        }
        if (method === 'POST') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          let payload = {};
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          } catch {
            json(res, 400, { error: 'invalid JSON body' });
            return;
          }
          json(res, 200, autostart.set(payload.enabled === true));
          return;
        }
        json(res, 405, { error: 'method not allowed' });
        return;
      }
      // 互动统计：只读，给设置页展示
      if (pathname === '/pet-app/stats') {
        if (method !== 'GET') {
          json(res, 405, { error: 'method not allowed' });
          return;
        }
        json(res, 200, stats ? stats() : { days: {}, totals: {} });
        return;
      }
      if (await serveStatic(res, staticRoots, pathname)) return;

      const route = routes.find((candidate) => matches(candidate, pathname));
      if (route === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`dsh-pet-app: 没有匹配的路由 ${pathname}`);
        return;
      }
      // 插件 handler 自己读 body（PUT/POST 的 JSON）：这里绝不能先消费请求流，
      // 否则设置页保存会拿到空 body → 400 invalid JSON body。
      await route.handler(req, res);
    } catch (error) {
      logger.error(`请求失败 ${method} ${pathname}：${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.destroy();
    }
  });

  server.on('clientError', (_error, socket) => socket.destroy());
  const port = await bindFirstFree(server, preferredPort, logger);
  logger.info(`服务已监听 http://127.0.0.1:${port}/`);

  return {
    port,
    async close() {
      server.closeAllConnections();
      await new Promise((accept) => server.close(() => accept()));
    },
  };
}
