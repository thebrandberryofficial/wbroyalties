"use client"

import { useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { CalendarRange } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent } from "@/components/ui/card"

export type DashboardRange = "all" | "30d" | "90d" | "custom"

const PRESETS: { value: Exclude<DashboardRange, "custom">; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
]

export function DateRangePicker({
  range,
  from,
  to,
  caption,
}: {
  range: DashboardRange
  from?: string
  to?: string
  caption: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [showCustom, setShowCustom] = useState(range === "custom")
  const [customFrom, setCustomFrom] = useState(range === "custom" ? (from ?? "") : "")
  const [customTo, setCustomTo] = useState(range === "custom" ? (to ?? "") : "")

  function selectPreset(value: Exclude<DashboardRange, "custom">) {
    setShowCustom(false)
    router.push(value === "all" ? pathname : `${pathname}?range=${value}`)
  }

  function applyCustom() {
    if (!customFrom && !customTo) return
    const params = new URLSearchParams({ range: "custom" })
    if (customFrom) params.set("from", customFrom)
    if (customTo) params.set("to", customTo)
    router.push(`${pathname}?${params.toString()}`)
  }

  const invalidOrder = Boolean(customFrom && customTo && customFrom > customTo)

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((preset) => (
            <Button
              key={preset.value}
              variant={!showCustom && range === preset.value ? "default" : "outline"}
              onClick={() => selectPreset(preset.value)}
            >
              {preset.label}
            </Button>
          ))}
          <Button
            variant={showCustom ? "default" : "outline"}
            onClick={() => setShowCustom(true)}
          >
            <CalendarRange data-icon="inline-start" />
            Custom range
          </Button>
          <span className="text-xs text-muted-foreground sm:ml-auto">{caption}</span>
        </div>

        {showCustom && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">From</span>
              <Input
                type="date"
                value={customFrom}
                max={customTo || undefined}
                onChange={(event) => setCustomFrom(event.target.value)}
                className="w-40"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">To</span>
              <Input
                type="date"
                value={customTo}
                min={customFrom || undefined}
                onChange={(event) => setCustomTo(event.target.value)}
                className="w-40"
              />
            </div>
            <Button
              variant="secondary"
              onClick={applyCustom}
              disabled={(!customFrom && !customTo) || invalidOrder}
            >
              Apply
            </Button>
            {invalidOrder && (
              <span className="text-xs text-destructive">
                The start date must be before the end date.
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
