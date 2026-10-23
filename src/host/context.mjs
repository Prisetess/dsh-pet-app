/**
 * 伪 Cordis 上下文 —— 让 dsh-pet 的宿主半边在 DSH 之外跑起来。
 *
 * 这份实现与插件自带的 src/standalone/context.ts 同口径（DSH 服务换成"显式降级"的替身），
 * 差别只有两点：
 *   1. 多一个 get(name, fallback)：宿主半边会 ctx.get('deepseekAccount', false) 查账号能力；
 *   2. 日志直接进本 App 的日志，不写 DSH 的 logger。
 *
 * 降级口径（都是明确失败，不假装成功）：
 *   agentDefaultModel.currentSelection() → { provider: 'standalone', model: '' }
 *   credentials.resolve()               → undefined      → 余额走 unsupported / credential-missing
 *   llm.stream()                        → 空流（首次 next 抛错）→ 碎碎念/对话 provider-missing
 *   ctx.on(...)                         → 不订阅           → 工作状态永远空闲
 */
export const STANDALONE_PROVIDER = 'standalone';

export function createLogger(prefix = '[host]') {
  const write = (level, message) =>
    console.log(`${prefix} ${new Date().toISOString().slice(11, 19)} ${level} ${message}`);
  return {
    info: (message) => write('INFO ', String(message)),
    warn: (message) => write('WARN ', String(message)),
    error: (message) => write('ERROR', String(message)),
    debug: (message) => {
      if (process.env.DSH_PET_DEBUG === '1') write('DEBUG', String(message));
    },
  };
}

/**
 * @param {{ port: number | (() => number), logger: object, routes?: Array }} options
 */
export function createStandaloneContext(options) {
  const { logger } = options;
  const routes = options.routes ?? [];
  const failures = [];
  const disposers = [];
  let disposed = false;

  const portOf = () => (typeof options.port === 'function' ? options.port() : options.port);

  const webServer = {
    get port() {
      return portOf();
    },
    register(spec) {
      routes.push({ kind: spec.kind, path: spec.path, handler: spec.handler });
      return () => {
        const index = routes.findIndex((route) => route.handler === spec.handler);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };

  const context = {
    effect(fn) {
      try {
        const dispose = fn();
        if (typeof dispose === 'function') disposers.push(dispose);
        return dispose;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(message);
        logger.error(`初始化某项失败（已跳过）：${message}`);
        return undefined;
      }
    },
    on() {
      return () => {};
    },
    /** 宿主半边用它探测可选服务（如 deepseekAccount）：一律没有 */
    get() {
      return undefined;
    },
    logger,
    webServer,
    commands: { register: () => () => {} },
    agentDefaultModel: {
      currentSelection: () => ({ provider: STANDALONE_PROVIDER, model: '' }),
    },
    credentials: { resolve: async () => undefined },
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      resolveModelInfo: async () => undefined,
      /** 契约是 AsyncIterable：错误在首次 next() 抛出，正好落进调用方的 try/catch */
      stream: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              throw new Error('独立 App：未接入模型（碎碎念/对话不可用）');
            },
          };
        },
      }),
    },
  };

  return {
    ctx: context,
    routes,
    failures,
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          await dispose();
        } catch (error) {
          logger.warn(`释放某项失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
  };
}
