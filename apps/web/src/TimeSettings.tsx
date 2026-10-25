import React, { useState } from "react";
import { Alert } from "./ui";
import { displayTimeZone } from "./api";

export function TimeSettings() {
  const [zone, setZone] = useState(displayTimeZone() || "");
  const [error, setError] = useState("");
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const supported = (
    Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf?.("timeZone") || [device, "UTC"];
  const zones = Array.from(new Set(["UTC", device, ...supported])).sort();
  return (
    <section className="panel form-stack">
      <h2>Time in your corner</h2>
      <p>
        Dates and expiration warnings use this display timezone on this browser.
        Deadlines are the same instant for everyone.
      </p>
      <label className="field">
        <span>Display timezone</span>
        <select
          value={zone}
          onChange={(e) => {
            const next = e.target.value;
            try {
              if (next)
                new Intl.DateTimeFormat(undefined, { timeZone: next }).format();
              if (next) localStorage.setItem("porchday-timezone", next);
              else localStorage.removeItem("porchday-timezone");
              setZone(next);
              setError("");
            } catch {
              setError("This browser could not save the timezone preference.");
            }
          }}
        >
          <option value="">Use this device’s timezone ({device})</option>
          {zones.map((value) => (
            <option key={value} value={value}>
              {value.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </label>
      <p className="small-copy">
        Custom expiration inputs follow your device clock ({device}). The
        warning then confirms the resulting time in your selected display
        timezone.
      </p>
      <Alert>{error}</Alert>
    </section>
  );
}
