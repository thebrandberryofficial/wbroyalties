import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

export function KpiSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {Array.from({ length: count }, (_, i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-4 w-24" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-6 w-32" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

export function BlockSkeleton({ className = "h-72" }: { className?: string }) {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-4 w-40" />
      </CardHeader>
      <CardContent>
        <Skeleton className={`w-full ${className}`} />
      </CardContent>
    </Card>
  )
}

export function ContentSkeleton({ blocks = 3 }: { blocks?: number }) {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-6">
      <KpiSkeleton />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <BlockSkeleton key={i} className="h-10" />
        ))}
      </div>
      {Array.from({ length: blocks }, (_, i) => (
        <BlockSkeleton key={i} />
      ))}
    </div>
  )
}
