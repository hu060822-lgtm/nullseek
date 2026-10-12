/// <reference types="vite/client" />
import type { JSX as ReactJSX } from 'react';

declare global {
  // React 19 不再提供全域 JSX 命名空間；這裡補上，讓元件可以寫 JSX.Element
  namespace JSX {
    type Element = ReactJSX.Element;
  }
  interface ImportMetaEnv {
    readonly VITE_SERVER_URL?: string;
  }
}
