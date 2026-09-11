"use client";

/**
 * Real user feedback: "Sometimes when I do search there are 30 results being returned it is a bit
 * overwhelming. Can we give option to either have top 5 or top 10 or ALL search results to be
 * provided?" — a plain native `<select>` (same pattern as the fuel-type picker on Home,
 * `search-form.tsx`) synced to the `/search` route's own `limit` query param
 * (`handle-search-request.ts`'s `resolveDisplayLimit`), so a change here is just a normal
 * navigation to the same results with every other param preserved — no client-side result
 * filtering, the server always returns exactly what was asked for.
 */
import { useRouter } from "next/navigation";
import { useId } from "react";

import styles from "./results-limit-selector.module.css";

const OPTIONS: Array<{ value: "5" | "10" | "all"; label: string }> = [
  { value: "5", label: "Top 5" },
  { value: "10", label: "Top 10" },
  { value: "all", label: "All" },
];

export function ResultsLimitSelector({
  currentLimit,
  searchParams,
}: {
  currentLimit: "5" | "10" | "all";
  searchParams: URLSearchParams;
}) {
  const router = useRouter();
  const selectId = useId();

  function handleChange(value: string) {
    const next = new URLSearchParams(searchParams);
    next.set("limit", value);
    router.push(`/search?${next.toString()}`);
  }

  return (
    <label className={styles.wrapper} htmlFor={selectId}>
      <span className={styles.label}>Show</span>
      <select
        id={selectId}
        className={styles.select}
        value={currentLimit}
        onChange={(e) => handleChange(e.target.value)}
      >
        {OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
