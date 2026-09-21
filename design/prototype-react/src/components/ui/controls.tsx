import * as Switch from '@radix-ui/react-switch'
import * as Slider from '@radix-ui/react-slider'
import { cn } from '@/lib/utils'

/** 对齐原型 .toggle 的开关 */
export function Toggle({
  checked,
  onChange,
  style,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  style?: React.CSSProperties
}) {
  return (
    <Switch.Root
      className={cn('toggle', checked && 'on')}
      checked={checked}
      onCheckedChange={onChange}
      style={style}
    >
      <Switch.Thumb />
    </Switch.Root>
  )
}

/** 对齐原型 input[type=range] 的滑杆 */
export function RangeSlider({
  value,
  min,
  max,
  step,
  onChange,
}: {
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <Slider.Root
      className="rslider"
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={v => onChange(v[0])}
    >
      <Slider.Track className="rs-track">
        <Slider.Range className="rs-range" />
      </Slider.Track>
      <Slider.Thumb className="rs-thumb" aria-label="value" />
    </Slider.Root>
  )
}
