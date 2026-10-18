import type { ReactNode } from 'react'

/**
 * Hybrid Solid（语义实心 + 工具 1.75px 精密线性）现代图标体系
 * 与 crates/jagent-app/src/icons.rs 1:1 同源 SVG。
 */
const SVG_PATHS: Record<string, ReactNode> = {
  // ── 语义实心组（Semantic Solid Cutout）──
  chat: (
    <path
      fill="currentColor"
      stroke="none"
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3Zm-3.5 8a1 1 0 0 1 1-1h5a1 1 0 1 1 0 2h-5a1 1 0 0 1-1-1Zm1 3a1 1 0 1 0 0 2h3a1 1 0 1 0 0-2h-3Z"
    />
  ),
  terminal: (
    <path
      fill="currentColor"
      stroke="none"
      fillRule="evenodd"
      clipRule="evenodd"
      d="M5 4a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3H5Zm2.2 5.3a1 1 0 0 1 1.4 0l2.5 2.5a1 1 0 0 1 0 1.4l-2.5 2.5a1 1 0 1 1-1.4-1.4l1.8-1.8-1.8-1.8a1 1 0 0 1 0-1.4ZM12.5 14a1 1 0 1 0 0 2h4a1 1 0 1 0 0-2h-4Z"
    />
  ),
  acp: (
    <path
      fill="currentColor"
      stroke="none"
      d="M11.5 2.5l2.35 5.95 5.95 2.35-5.95 2.35-2.35 5.95-2.35-5.95-5.95-2.35 5.95-2.35L11.5 2.5ZM19 2.5l.85 2.15 2.15.85-2.15.85-.85 2.15-.85-2.15-2.15-.85 2.15-.85.85-2.15Z"
    />
  ),
  agent: (
    <path
      fill="currentColor"
      stroke="none"
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2a1.5 1.5 0 0 1 1 2.6V6h4a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3h4V4.6A1.5 1.5 0 0 1 12 2Zm-3 9.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Zm6 0a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z"
    />
  ),
  folder: (
    <path
      fill="currentColor"
      stroke="none"
      d="M3 7.5A2.5 2.5 0 0 1 5.5 5h4.1a2 2 0 0 1 1.6.8l1.2 1.6a1 1 0 0 0 .8.4h5.3A2.5 2.5 0 0 1 21 10.3v7.2a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-10Z"
    />
  ),
  file: (
    <path
      fill="currentColor"
      stroke="none"
      fillRule="evenodd"
      clipRule="evenodd"
      d="M6 3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.5L14.5 3H6Zm7 2v4a1 1 0 0 0 1 1h4l-5-5Z"
    />
  ),
  tag: (
    <path
      fill="currentColor"
      stroke="none"
      fillRule="evenodd"
      clipRule="evenodd"
      d="M4 2a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4L12.6 2.6A2 2 0 0 0 11.2 2H4Zm3.5 7a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"
    />
  ),
  bell: (
    <path
      fill="currentColor"
      stroke="none"
      d="M6 8a6 6 0 0 1 12 0c0 4.5 1.5 6 2.7 7.3A1 1 0 0 1 20 17H4a1 1 0 0 1-.7-1.7C4.5 14 6 12.5 6 8ZM10.3 19.5a2 2 0 0 0 3.4 0h-3.4Z"
    />
  ),
  pin: (
    <path
      fill="currentColor"
      stroke="none"
      d="M8 2a2 2 0 1 0 0 4 1 1 0 0 1 1 1v3.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h5v5a1 1 0 1 0 2 0v-5h5a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 1 0 0-4H8Z"
    />
  ),
  home: (
    <path
      fill="currentColor"
      stroke="none"
      d="M10.7 3.1a2 2 0 0 1 2.6 0l7 6A2 2 0 0 1 21 10.62V19a2 2 0 0 1-2 2h-4.25v-6.25a1.25 1.25 0 0 0-1.25-1.25h-3a1.25 1.25 0 0 0-1.25 1.25V21H5a2 2 0 0 1-2-2v-8.38A2 2 0 0 1 3.7 9.1l7-6Z"
    />
  ),
  alert: (
    <path
      fill="currentColor"
      stroke="none"
      fillRule="evenodd"
      clipRule="evenodd"
      d="M10.3 3.9a2 2 0 0 1 3.4 0l8 14A2 2 0 0 1 20 21H4a2 2 0 0 1-1.7-3.1l8-14ZM12 8a1 1 0 0 1 1 1v4a1 1 0 1 1-2 0V9a1 1 0 0 1 1-1Zm0 9a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Z"
    />
  ),

  // ── 半实心 + 线性复合组（Hybrid Icons）──
  gitBranch: (
    <>
      <circle cx="18" cy="6" r="3" fill="currentColor" stroke="none" />
      <circle cx="6" cy="18" r="3" fill="currentColor" stroke="none" />
      <circle cx="6" cy="6" r="2.5" fill="currentColor" stroke="none" />
      <path d="M6 6v12" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </>
  ),
  panelLeft: (
    <>
      <path
        d="M3.5 5.5A2 2 0 0 1 5.5 3.5H9v17H5.5a2 2 0 0 1-2-2v-13Z"
        fill="currentColor"
        fillOpacity="0.28"
        stroke="none"
      />
      <rect width="18" height="18" x="3" y="3" rx="2.5" />
      <path d="M9 3v18" />
    </>
  ),
  panelRight: (
    <>
      <path
        d="M15 3.5h3.5a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H15v-17Z"
        fill="currentColor"
        fillOpacity="0.28"
        stroke="none"
      />
      <rect width="18" height="18" x="3" y="3" rx="2.5" />
      <path d="M15 3v18" />
    </>
  ),

  // ── 工具线性组（1.75px Precision Stroke）──
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="6.8" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6" />
    </>
  ),
  close: (
    <>
      <path d="M17.5 6.5 6.5 17.5" />
      <path d="m6.5 6.5 11 11" />
    </>
  ),
  minimize: <path d="M5 12h14" />,
  maximize: <rect width="18" height="18" x="3" y="3" rx="2.5" />,
  plus: (
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>
  ),
  chevronDown: <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  chevronUp: <path d="m17.5 14.5-5.5-5.5-5.5 5.5" />,
  chevronRight: <path d="m9.5 17.5 5.5-5.5-5.5-5.5" />,
  arrowLeft: (
    <>
      <path d="M19 12H5" />
      <path d="m11.5 18.5-6.5-6.5 6.5-6.5" />
    </>
  ),
  arrowRight: (
    <>
      <path d="M5 12h14" />
      <path d="m12.5 5.5 6.5 6.5-6.5 6.5" />
    </>
  ),
  reset: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.49-6.01L3.5 8.5" />
      <path d="M3.5 3.5v5h5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  copy: (
    <>
      <rect width="13" height="13" x="8" y="8" rx="2.2" />
      <path d="M4.5 15.5A1.5 1.5 0 0 1 3 14V5a2 2 0 0 1 2-2h9a1.5 1.5 0 0 1 1.5 1.5" />
    </>
  ),
  trash: (
    <>
      <path d="M4 6.5h16" />
      <path d="M18.5 6.5v12a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-12" />
      <path d="M8.5 6.5v-2a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v2" />
      <path d="M10 11v5.5" />
      <path d="M14 11v5.5" />
    </>
  ),
  menu: (
    <>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
    </>
  ),
  more: (
    <>
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  download: (
    <>
      <path d="M12 15V3.5" />
      <path d="M20.5 15v3.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V15" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
    </>
  ),
  check: <path d="M19.5 6.5 9.2 16.8 4.5 12.1" />,
  edit: (
    <>
      <path d="M16.86 3.86a2.1 2.1 0 0 1 2.97 2.97L7.5 19.16 3 20.5l1.34-4.5L16.86 3.86Z" />
      <path d="m14.5 6.5 3 3" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 12.5h5.2l1.6 2.5h4.4l1.6-2.5H21" />
      <path d="M5.4 4.8 3 12.5v5A2.5 2.5 0 0 0 5.5 20h13a2.5 2.5 0 0 0 2.5-2.5v-5L18.6 4.8A2 2 0 0 0 16.7 3.5H7.3a2 2 0 0 0-1.9 1.3Z" />
    </>
  ),
}

export function Icon({ name, size = 14 }: { name: string; size?: number }) {
  const body = SVG_PATHS[name] ?? SVG_PATHS.file
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, display: 'inline-block', verticalAlign: 'middle' }}
    >
      {body}
    </svg>
  )
}
