import { createContext, useContext } from 'react'

/** #app 窗口容器——Radix Portal 的挂载点，保证浮层留在模拟窗口内 */
export const AppRootCtx = createContext<HTMLElement | null>(null)
export const useAppRoot = () => useContext(AppRootCtx)
