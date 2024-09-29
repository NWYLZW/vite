import type { FetchFunctionOptions, FetchResult } from 'vite/module-runner'
import type { FSWatcher } from 'dep-types/chokidar'
import colors from 'picocolors'
import { BaseEnvironment } from '../baseEnvironment'
import { ERR_OUTDATED_OPTIMIZED_DEP } from '../plugins/optimizedDeps'
import type {
  EnvironmentOptions,
  ResolvedConfig,
  ResolvedEnvironmentOptions,
} from '../config'
import { getDefaultResolvedEnvironmentOptions } from '../config'
import { mergeConfig, promiseWithResolvers } from '../utils'
import { fetchModule } from '../ssr/fetchModule'
import type { DepsOptimizer } from '../optimizer'
import { isDepOptimizationDisabled } from '../optimizer'
import {
  createDepsOptimizer,
  createExplicitDepsOptimizer,
} from '../optimizer/optimizer'
import { resolveEnvironmentPlugins } from '../plugin'
import { EnvironmentModuleGraph } from './moduleGraph'
import type { EnvironmentModuleNode } from './moduleGraph'
import type { HotChannel } from './hmr'
import { createNoopHotChannel, getShortName, updateModules } from './hmr'
import type { TransformResult } from './transformRequest'
import { transformRequest } from './transformRequest'
import type { EnvironmentPluginContainer } from './pluginContainer'
import {
  ERR_CLOSED_SERVER,
  createEnvironmentPluginContainer,
} from './pluginContainer'
import type { RemoteEnvironmentTransport } from './environmentTransport'
import { isWebSocketServer } from './ws'

export interface DevEnvironmentContext {
  hot: false | HotChannel
  options?: EnvironmentOptions
  remoteRunner?: {
    inlineSourceMap?: boolean
    transport?: RemoteEnvironmentTransport
  }
  depsOptimizer?: DepsOptimizer
}

export class DevEnvironment extends BaseEnvironment {
  mode = 'dev' as const
  moduleGraph: EnvironmentModuleGraph

  depsOptimizer?: DepsOptimizer
  /**
   * @internal
   */
  _remoteRunnerOptions: DevEnvironmentContext['remoteRunner']

  get pluginContainer(): EnvironmentPluginContainer {
    if (!this._pluginContainer)
      throw new Error(
        `${this.name} environment.pluginContainer called before initialized`,
      )
    return this._pluginContainer
  }
  /**
   * @internal
   */
  _pluginContainer: EnvironmentPluginContainer | undefined

  /**
   * @internal
   */
  _closing: boolean = false
  /**
   * @internal
   */
  _pendingRequests: Map<
    string,
    {
      request: Promise<TransformResult | null>
      timestamp: number
      abort: () => void
    }
  >
  /**
   * @internal
   */
  _crawlEndFinder: CrawlEndFinder

  /**
   * Hot channel for this environment. If not provided or disabled,
   * it will be a noop channel that does nothing.
   *
   * @example
   * environment.hot.send({ type: 'full-reload' })
   */
  hot: HotChannel
  constructor(
    name: string,
    config: ResolvedConfig,
    context: DevEnvironmentContext,
  ) {
    let options =
      config.environments[name] ?? getDefaultResolvedEnvironmentOptions(config)
    if (context.options) {
      options = mergeConfig(
        options,
        context.options,
      ) as ResolvedEnvironmentOptions
    }
    super(name, config, options)

    this._pendingRequests = new Map()

    this.moduleGraph = new EnvironmentModuleGraph(name, (url: string) =>
      this.pluginContainer!.resolveId(url, undefined),
    )

    this.hot = context.hot || createNoopHotChannel()

    this._crawlEndFinder = setupOnCrawlEnd()

    this._remoteRunnerOptions = context.remoteRunner ?? {}
    context.remoteRunner?.transport?.register(this)

    this.hot.on('vite:invalidate', async ({ path, message }) => {
      invalidateModule(this, {
        path,
        message,
      })
    })

    const { optimizeDeps } = this.config.dev
    if (context.depsOptimizer) {
      this.depsOptimizer = context.depsOptimizer
    } else if (isDepOptimizationDisabled(optimizeDeps)) {
      this.depsOptimizer = undefined
    } else {
      // We only support auto-discovery for the client environment, for all other
      // environments `noDiscovery` has no effect and a simpler explicit deps
      // optimizer is used that only optimizes explicitly included dependencies
      // so it doesn't need to reload the environment. Now that we have proper HMR
      // and full reload for general environments, we can enable auto-discovery for
      // them in the future
      this.depsOptimizer = (
        optimizeDeps.noDiscovery || options.consumer !== 'client'
          ? createExplicitDepsOptimizer
          : createDepsOptimizer
      )(this)
    }
  }

  async init(options?: { watcher?: FSWatcher }): Promise<void> {
    if (this._initiated) {
      return
    }
    this._initiated = true
    this._plugins = resolveEnvironmentPlugins(this)
    this._pluginContainer = await createEnvironmentPluginContainer(
      this,
      this._plugins,
      options?.watcher,
    )
  }

  fetchModule(
    id: string,
    importer?: string,
    options?: FetchFunctionOptions,
  ): Promise<FetchResult> {
    return fetchModule(this, id, importer, {
      ...this._remoteRunnerOptions,
      ...options,
    })
  }

  async reloadModule(module: EnvironmentModuleNode): Promise<void> {
    if (this.config.server.hmr !== false && module.file) {
      updateModules(this, module.file, [module], Date.now())
    }
  }

  transformRequest(url: string): Promise<TransformResult | null> {
    return transformRequest(this, url)
  }

  async warmupRequest(url: string): Promise<void> {
    try {
      await this.transformRequest(url)
    } catch (e) {
      if (
        e?.code === ERR_OUTDATED_OPTIMIZED_DEP ||
        e?.code === ERR_CLOSED_SERVER
      ) {
        // these are expected errors
        return
      }
      // Unexpected error, log the issue but avoid an unhandled exception
      this.logger.error(`Pre-transform error: ${e.message}`, {
        error: e,
        timestamp: true,
      })
    }
  }

  async close(): Promise<void> {
    this._closing = true

    this._crawlEndFinder?.cancel()
    await Promise.allSettled([
      this.pluginContainer.close(),
      this.depsOptimizer?.close(),
      // WebSocketServer is independent of HotChannel and should not be closed on environment close
      isWebSocketServer in this.hot ? Promise.resolve() : this.hot.close(),
      (async () => {
        while (this._pendingRequests.size > 0) {
          await Promise.allSettled(
            [...this._pendingRequests.values()].map(
              (pending) => pending.request,
            ),
          )
        }
      })(),
    ])
  }

  /**
   * Calling `await environment.waitForRequestsIdle(id)` will wait until all static imports
   * are processed after the first transformRequest call. If called from a load or transform
   * plugin hook, the id needs to be passed as a parameter to avoid deadlocks.
   * Calling this function after the first static imports section of the module graph has been
   * processed will resolve immediately.
   * @experimental
   */
  waitForRequestsIdle(ignoredId?: string): Promise<void> {
    return this._crawlEndFinder.waitForRequestsIdle(ignoredId)
  }

  /**
   * @internal
   */
  _registerRequestProcessing(id: string, done: () => Promise<unknown>): void {
    this._crawlEndFinder.registerRequestProcessing(id, done)
  }
}

function invalidateModule(
  environment: DevEnvironment,
  m: {
    path: string
    message?: string
  },
) {
  const mod = environment.moduleGraph.urlToModuleMap.get(m.path)
  if (
    mod &&
    mod.isSelfAccepting &&
    mod.lastHMRTimestamp > 0 &&
    !mod.lastHMRInvalidationReceived
  ) {
    mod.lastHMRInvalidationReceived = true
    environment.logger.info(
      colors.yellow(`hmr invalidate `) +
        colors.dim(m.path) +
        (m.message ? ` ${m.message}` : ''),
      { timestamp: true },
    )
    const file = getShortName(mod.file!, environment.config.root)
    updateModules(
      environment,
      file,
      [...mod.importers],
      mod.lastHMRTimestamp,
      true,
    )
  }
}

const callCrawlEndIfIdleAfterMs = 50

interface CrawlEndFinder {
  registerRequestProcessing: (id: string, done: () => Promise<any>) => void
  waitForRequestsIdle: (ignoredId?: string) => Promise<void>
  cancel: () => void
}

function setupOnCrawlEnd(): CrawlEndFinder {
  const registeredIds = new Set<string>()
  const seenIds = new Set<string>()
  const onCrawlEndPromiseWithResolvers = promiseWithResolvers<void>()

  let timeoutHandle: NodeJS.Timeout | undefined

  let cancelled = false
  function cancel() {
    cancelled = true
  }

  function registerRequestProcessing(
    id: string,
    done: () => Promise<any>,
  ): void {
    if (!seenIds.has(id)) {
      seenIds.add(id)
      registeredIds.add(id)
      done()
        .catch(() => {})
        .finally(() => markIdAsDone(id))
    }
  }

  function waitForRequestsIdle(ignoredId?: string): Promise<void> {
    if (ignoredId) {
      seenIds.add(ignoredId)
      markIdAsDone(ignoredId)
    } else {
      checkIfCrawlEndAfterTimeout()
    }
    return onCrawlEndPromiseWithResolvers.promise
  }

  function markIdAsDone(id: string): void {
    registeredIds.delete(id)
    checkIfCrawlEndAfterTimeout()
  }

  function checkIfCrawlEndAfterTimeout() {
    if (cancelled || registeredIds.size > 0) return

    if (timeoutHandle) clearTimeout(timeoutHandle)
    timeoutHandle = setTimeout(
      callOnCrawlEndWhenIdle,
      callCrawlEndIfIdleAfterMs,
    )
  }
  async function callOnCrawlEndWhenIdle() {
    if (cancelled || registeredIds.size > 0) return
    onCrawlEndPromiseWithResolvers.resolve()
  }

  return {
    registerRequestProcessing,
    waitForRequestsIdle,
    cancel,
  }
}