import { getCurrentInstance, reactive } from 'vue'
import type VueRouter from 'vue-router'
import type { Location, RawLocation, Route, NavigationFailure } from 'vue-router'
import { sendRedirect } from 'h3'
import { useRouter as useVueRouter, useRoute as useVueRoute } from 'vue-router/composables'
import { hasProtocol, joinURL, parseURL, withQuery, isScriptProtocol } from 'ufo'
import { useNuxtApp, callWithNuxt, useRuntimeConfig } from '../nuxt'
import { createError, showError } from './error'
import type { NuxtError } from './error'

// Auto-import equivalents for `vue-router`
export const useRouter = () => {
  if (getCurrentInstance()) {
    return useVueRouter()
  }

  return useNuxtApp()?.nuxt2Context.app.router as VueRouter
}

// This provides an equivalent interface to `vue-router` (unlike legacy implementation)
export const useRoute = () => {
  if (getCurrentInstance()) {
    return useVueRoute()
  }

  const nuxtApp = useNuxtApp()

  if (!nuxtApp._route) {
    Object.defineProperty(nuxtApp, '__route', {
      get: () => nuxtApp.nuxt2Context.app.context.route
    })
    nuxtApp._route = reactive(nuxtApp.__route)
    const router = useRouter()
    router.afterEach(route => Object.assign(nuxtApp._route, route))
  }

  return nuxtApp._route as Route
}

export interface AddRouteMiddlewareOptions {
  global?: boolean
}

/** internal */
function convertToLegacyMiddleware (middleware) {
  return async (ctx: any) => {
    // because the middleware is executed before the plugin
    ctx.$_nuxtApp._processingMiddleware = true
    const result = await callWithNuxt(ctx.$_nuxtApp, middleware, [ctx.route, ctx.from])
    delete ctx.$_nuxtApp._processingMiddleware
    if (result instanceof Error) {
      return ctx.error(result)
    }
    if (result) {
      return ctx.redirect(result)
    }
    return result
  }
}

const isProcessingMiddleware = () => {
  try {
    if (useNuxtApp()._processingMiddleware) {
      return true
    }
  } catch {
    // Within an async middleware
    return true
  }
  return false
}

// Conditional types, either one or other
type Without<T, U> = { [P in Exclude<keyof T, keyof U>]?: never }
type XOR<T, U> = (T | U) extends Object ? (Without<T, U> & U) | (Without<U, T> & T) : T | U

export type OpenWindowFeatures = {
  popup?: boolean
  noopener?: boolean
  noreferrer?: boolean
} & XOR<{width?: number}, {innerWidth?: number}>
  & XOR<{height?: number}, {innerHeight?: number}>
  & XOR<{left?: number}, {screenX?: number}>
  & XOR<{top?: number}, {screenY?: number}>

export type OpenOptions = {
  target: '_blank' | '_parent' | '_self' | '_top' | (string & {})
  windowFeatures?: OpenWindowFeatures
}

export interface NavigateToOptions {
  replace?: boolean
  redirectCode?: number
  external?: boolean
  open?: OpenOptions
}

export const navigateTo = (to: RawLocation | undefined | null, options?: NavigateToOptions): Promise<void | Route | NavigationFailure> | RawLocation | Route => {
  if (!to) {
    to = '/'
  }
  const toPath = typeof to === 'string' ? to : (withQuery((to as Route).path || '/', to.query || {}) + (to.hash || ''))

  if (options?.open) {
    if (import.meta.client) {
      const { target = '_blank', windowFeatures = {} } = options.open

      const features = Object.entries(windowFeatures)
        .filter(([_, value]) => value !== undefined)
        .map(([feature, value]) => `${feature.toLowerCase()}=${value}`)
        .join(', ')

      open(toPath, target, features)
      return Promise.resolve()
    }
  }

  const isExternal = options?.external || hasProtocol(toPath, { acceptRelative: true })
  if (isExternal) {
    if (!options?.external) {
      throw new Error('Navigating to an external URL is not allowed by default. Use `navigateTo(url, { external: true })`.')
    }
    const protocol = parseURL(toPath).protocol
    if (protocol && isScriptProtocol(protocol)) {
      throw new Error(`Cannot navigate to a URL with '${protocol}' protocol.`)
    }
  }

  // Early redirect on client-side
  if (process.client && !isExternal && isProcessingMiddleware()) {
    return to
  }
  const router = useRouter()
  if (process.server) {
    const nuxtApp = useNuxtApp()
    if (nuxtApp.ssrContext && nuxtApp.ssrContext.event) {
      const redirectLocation = isExternal ? toPath : joinURL(useRuntimeConfig().app.baseURL, router.resolve(to).resolved.fullPath || '/')

      // @ts-expect-error
      return nuxtApp.callHook('app:redirected').then(() => sendRedirect(nuxtApp.ssrContext!.event, redirectLocation, options?.redirectCode || 302))
    }
  }
  // Client-side redirection using vue-router
  if (isExternal) {
    if (options?.replace) {
      location.replace(toPath)
    } else {
      location.href = toPath
    }
    return Promise.resolve()
  }
  return options?.replace ? router.replace(to) : router.push(to)
}

/** This will abort navigation within a Nuxt route middleware handler. */
export const abortNavigation = (err?: string | Partial<NuxtError>) => {
  if (process.dev && !isProcessingMiddleware()) {
    throw new Error('abortNavigation() is only usable inside a route middleware handler.')
  }
  if (!err) { return false }

  err = createError(err)

  if (err.fatal) {
    const nuxtApp = useNuxtApp()
    callWithNuxt(nuxtApp, showError, [err as NuxtError])
  }

  throw err
}

type RouteMiddlewareReturn = void | Error | string | Location | boolean | Route

export interface RouteMiddleware {
  (to: Route, from: Route): RouteMiddlewareReturn | Promise<RouteMiddlewareReturn>
}

export const defineNuxtRouteMiddleware = (middleware: RouteMiddleware) => convertToLegacyMiddleware(middleware)

interface AddRouteMiddleware {
  (name: string, middleware: RouteMiddleware, options?: AddRouteMiddlewareOptions): void
  (middleware: RouteMiddleware): void
}

export const addRouteMiddleware: AddRouteMiddleware = (name: string | RouteMiddleware, middleware?: RouteMiddleware, options: AddRouteMiddlewareOptions = {}) => {
  const nuxtApp = useNuxtApp()
  if (options.global || typeof name === 'function') {
    nuxtApp._middleware.global.push(typeof name === 'function' ? name : middleware)
  } else {
    nuxtApp._middleware.named[name] = convertToLegacyMiddleware(middleware)
  }
}
