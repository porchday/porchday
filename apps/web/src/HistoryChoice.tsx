import React from "react";

export function HistoryChoice({ value, onChange, disabled }: { value: "full" | "future"; onChange: (value: "full" | "future") => void; disabled?: boolean }) {
  return <label className="field history-choice">
    <span>Share your posts and photos</span>
    <select aria-label="Share your posts and photos" value={value} disabled={disabled} onChange={event => onChange(event.target.value as "full" | "future")}>
      <option value="full">Share full history (recommended)</option>
      <option value="future">Only share new posts and photos</option>
    </select>
  </label>;
}
