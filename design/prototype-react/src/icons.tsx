import {
  ArrowLeft, ArrowRight, Bell, Bot, Check, ChevronDown, ChevronRight, ChevronUp,
  CircleDot, Copy, Download, File, Folder, GitBranch, Inbox, Menu, Minus, MoreHorizontal,
  House, PanelLeft, PanelRight, Pencil, Pin, Plus, RotateCcw, Search, Settings, Square,
  Tag, Terminal, Trash2, TrendingUp, TriangleAlert, X,
} from 'lucide-react'
import type { ComponentType } from 'react'

const MAP: Record<string, ComponentType<{ size?: number; strokeWidth?: number }>> = {
  chat: CircleDot,
  terminal: Terminal,
  acp: TrendingUp,
  gear: Settings,
  close: X,
  minimize: Minus,
  maximize: Square,
  plus: Plus,
  chevronDown: ChevronDown,
  chevronUp: ChevronUp,
  chevronRight: ChevronRight,
  arrowLeft: ArrowLeft,
  arrowRight: ArrowRight,
  reset: RotateCcw,
  search: Search,
  copy: Copy,
  trash: Trash2,
  folder: Folder,
  inbox: Inbox,
  file: File,
  menu: Menu,
  bell: Bell,
  more: MoreHorizontal,
  gitBranch: GitBranch,
  tag: Tag,
  download: Download,
  panelLeft: PanelLeft,
  panelRight: PanelRight,
  check: Check,
  edit: Pencil,
  agent: Bot,
  pin: Pin,
  alert: TriangleAlert,
  home: House,
}

export function Icon({ name, size = 14 }: { name: string; size?: number }) {
  const C = MAP[name] ?? Square
  return <C size={size} strokeWidth={2} />
}
