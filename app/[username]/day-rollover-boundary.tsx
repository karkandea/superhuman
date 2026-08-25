'use client'

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { todayStr } from '@/lib/checklist-data'

export function hasLocalDayChanged(previousDay: string, currentDay: string) {
  return previousDay !== currentDay
}

export default function DayRolloverBoundary({ children }: { children: ReactNode }) {
  const initialDay = todayStr()
  const dayRef = useRef(initialDay)
  const [dayKey, setDayKey] = useState(initialDay)

  useEffect(() => {
    function reconcileDay() {
      const nextDay = todayStr()
      if (!hasLocalDayChanged(dayRef.current, nextDay)) return
      dayRef.current = nextDay
      setDayKey(nextDay)
    }

    const timer = window.setInterval(reconcileDay, 30_000)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') reconcileDay()
    }

    window.addEventListener('focus', reconcileDay)
    window.addEventListener('pageshow', reconcileDay)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', reconcileDay)
      window.removeEventListener('pageshow', reconcileDay)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  return <Fragment key={dayKey}>{children}</Fragment>
}
