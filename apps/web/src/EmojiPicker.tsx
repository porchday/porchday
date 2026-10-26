import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  canonicalUnicode,
  LEGACY_REACTIONS,
  reactionDisplay,
  UNICODE_EMOJI,
  unicodeReaction,
  type ReactionPayload,
} from "@porchday/crypto/reactions";
import { useVault } from "./vault";
import { Alert, Button, Modal, useAction } from "./ui";
import {
  emojiLibraryIO,
  readEmojiLibrary,
  updateEmojiLibrary,
  type CustomEmoji,
} from "./emoji-library";
import { prepareCustomEmoji, validateCustomEmojiPixels } from "./emoji-images";

export function EmojiGlyph({ value }: { value: ReactionPayload }) {
  const display = reactionDisplay(value);
  const [checked, setChecked] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if ("custom" in value)
      void validateCustomEmojiPixels(value).then(
        () => {
          if (active) setChecked(value.emoji);
        },
        () => {
          if (active) setChecked(null);
        },
      );
    return () => {
      active = false;
    };
  }, [value.emoji, display.png]);
  if (display.unicode) return <span aria-hidden="true">{display.unicode}</span>;
  return checked === value.emoji && display.png ? (
    <img
      className="custom-emoji-image"
      src={"data:image/png;base64," + display.png}
      alt=""
      aria-hidden="true"
      width="28"
      height="28"
    />
  ) : (
    <span className="custom-emoji-placeholder" aria-hidden="true">
      ▧
    </span>
  );
}

export function searchEmoji(query: string, group: string, tone: string) {
  const text = query.trim().toLocaleLowerCase(),
    canonical = canonicalUnicode(query.trim());
  return UNICODE_EMOJI.filter((entry) => {
    if (group && entry.group !== group) return false;
    const modifiers = [...entry.unicode].filter((point) => {
      const code = point.codePointAt(0)!;
      return code >= 0x1f3fb && code <= 0x1f3ff;
    });
    if (
      (tone === "none" && modifiers.length) ||
      (tone && tone !== "none" && !modifiers.includes(tone))
    )
      return false;
    return (
      !text ||
      canonical === entry.unicode ||
      `${entry.name} ${entry.group} ${entry.subgroup}`
        .toLocaleLowerCase()
        .includes(text)
    );
  });
}

export function EmojiPicker({
  onSelect,
  onClose,
  busy = false,
  error = "",
  suggested = null,
  returnFocusRef,
}: {
  onSelect: (value: ReactionPayload) => Promise<void>;
  onClose: () => void;
  busy?: boolean;
  error?: string;
  suggested?: CustomEmoji | null;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const vault = useVault(),
    owner = vault.member.id + ":" + vault.device.id;
  const latestOwner = useRef(owner);
  latestOwner.current = owner;
  const mounted = useRef(true),
    mutating = useRef(false);
  const current = () => mounted.current && latestOwner.current === owner;
  const io = emojiLibraryIO(vault, current);
  const [view, setView] = useState<"unicode" | "custom">(
    suggested ? "custom" : "unicode",
  );
  const [query, setQuery] = useState(""),
    [group, setGroup] = useState(""),
    [tone, setTone] = useState(""),
    [shown, setShown] = useState(72);
  const [collection, setCollection] = useState<{
    owner: string;
    entries: CustomEmoji[];
  } | null>(null);
  const [loading, setLoading] = useState(false),
    [loadError, setLoadError] = useState("");
  const [file, setFile] = useState<File | null>(null),
    [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const action = useAction(),
    entries = collection?.owner === owner ? collection.entries : [];
  const disabled = busy || action.busy || vault.member.status === "restricted";
  const results = useMemo(
    () => searchEmoji(query, group, tone),
    [query, group, tone],
  );
  const groups = useMemo(
    () => [...new Set(UNICODE_EMOJI.map((entry) => entry.group))],
    [],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setShown(72);
  }, [query, group, tone]);
  useEffect(() => {
    let alive = true;
    if (view !== "custom") return;
    setLoading(true);
    setLoadError("");
    void readEmojiLibrary(io)
      .then((result) => {
        if (alive && current())
          setCollection({ owner, entries: result.payload.customEmojis });
      })
      .catch((e) => {
        if (alive && current())
          setLoadError(
            e instanceof Error
              ? e.message
              : "Could not load your emoji collection.",
          );
      })
      .finally(() => {
        if (alive && current()) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [owner, view]);
  async function choose(unicode: string) {
    await action.run(async () => {
      const value = await unicodeReaction(unicode);
      if (current()) await onSelect(value);
    });
  }
  async function save(add: CustomEmoji[] = [], remove: string[] = []) {
    if (mutating.current || disabled) return;
    mutating.current = true;
    await action.run(
      async () => {
        const result = await updateEmojiLibrary(io, { add, remove });
        if (current())
          setCollection({ owner, entries: result.payload.customEmojis });
      },
      remove.length
        ? "Removed from your collection. Existing reactions are unchanged."
        : "Saved to your private collection. Select an image to react.",
    );
    mutating.current = false;
  }
  async function upload(event: React.FormEvent) {
    event.preventDefault();
    if (!file || disabled || mutating.current) return;
    mutating.current = true;
    await action.run(async () => {
      const item = await prepareCustomEmoji(file, name);
      if (!current()) return;
      const result = await updateEmojiLibrary(io, { add: [item] });
      if (current()) {
        setCollection({ owner, entries: result.payload.customEmojis });
        setFile(null);
        setName("");
        if (input.current) input.current.value = "";
      }
    }, "Image saved. Select it below to react.");
    mutating.current = false;
  }
  return (
    <Modal
      title="Add a reaction"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      <div className="emoji-picker-content">
        <div className="button-row" aria-label="Reaction types">
          <button
            type="button"
            className="button outline compact"
            aria-pressed={view === "unicode"}
            onClick={() => setView("unicode")}
          >
            Emoji
          </button>
          <button
            type="button"
            className="button outline compact"
            aria-pressed={view === "custom"}
            onClick={() => setView("custom")}
          >
            My images
          </button>
        </div>
        {view === "unicode" ? (
          <>
            <label className="field">
              <span>Search names or paste an emoji</span>
              <input
                autoFocus
                value={query}
                maxLength={128}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="For example: bird, wave, 🐦"
              />
            </label>
            <div className="emoji-filters">
              <label className="field">
                <span>Category</span>
                <select
                  value={group}
                  onChange={(event) => setGroup(event.target.value)}
                >
                  <option value="">All categories</option>
                  {groups.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Contains skin tone</span>
                <select
                  value={tone}
                  onChange={(event) => setTone(event.target.value)}
                >
                  <option value="">All tones</option>
                  <option value="none">No modifier</option>
                  {[
                    ["🏻", "Light"],
                    ["🏼", "Medium-light"],
                    ["🏽", "Medium"],
                    ["🏾", "Medium-dark"],
                    ["🏿", "Dark"],
                  ].map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {!query && !group && !tone && (
              <div className="emoji-grid" aria-label="Common reactions">
                {LEGACY_REACTIONS.map((entry) => (
                  <button
                    type="button"
                    key={entry.id}
                    disabled={disabled}
                    title={entry.label}
                    aria-label={entry.label}
                    onClick={() => choose(entry.unicode)}
                  >
                    {entry.unicode}
                  </button>
                ))}
              </div>
            )}
            <p className="small-copy" role="status">
              {results.length} matching emoji. Appearance depends on your
              device.
            </p>
            <div className="emoji-grid" aria-label="Emoji results">
              {results.slice(0, shown).map((entry) => (
                <button
                  type="button"
                  key={entry.unicode}
                  disabled={disabled}
                  title={entry.name}
                  aria-label={entry.name}
                  onClick={() => choose(entry.unicode)}
                >
                  {entry.unicode}
                </button>
              ))}
            </div>
            {shown < results.length && (
              <Button
                variant="outline compact"
                onClick={() => setShown((value) => value + 72)}
              >
                Show more emoji
              </Button>
            )}
          </>
        ) : (
          <>
            <p>
              Saved images are encrypted for your account only. When you react,
              that image is shared with the post’s audience.
            </p>
            {loading && <p role="status">Loading your collection…</p>}
            <Alert>{loadError}</Alert>
            {suggested &&
              !entries.some((entry) => entry.emoji === suggested.emoji) && (
                <div className="emoji-save-offer">
                  <EmojiGlyph value={suggested} />
                  <span>{suggested.custom.name}</span>
                  <Button
                    variant="outline compact"
                    disabled={disabled}
                    onClick={() => save([suggested])}
                  >
                    Save to my images
                  </Button>
                </div>
              )}
            <form className="form-stack emoji-upload" onSubmit={upload}>
              <label className="field">
                <span>Static image</span>
                <input
                  ref={input}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={disabled}
                  onChange={(event) => {
                    const chosen = event.target.files?.[0] ?? null;
                    setFile(chosen);
                    if (chosen)
                      setName(
                        chosen.name
                          .replace(/\.[^.]+$/, "")
                          .toLowerCase()
                          .replace(/[^a-z0-9_]+/g, "_")
                          .slice(0, 32) || "image",
                      );
                  }}
                />
              </label>
              <label className="field">
                <span>Name</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  pattern="[a-z0-9_]{1,32}"
                  maxLength={32}
                  disabled={disabled}
                  aria-describedby="emoji-upload-help"
                />
              </label>
              <p id="emoji-upload-help" className="small-copy">
                Use lowercase letters, numbers, or underscores. PNG, JPEG, or
                WebP, up to 5 MB. Animated images are not supported.
              </p>
              <Button
                type="submit"
                variant="outline compact"
                disabled={disabled || !file || !name}
              >
                Save image
              </Button>
            </form>
            <h3>My images ({entries.length}/48)</h3>
            {!loading && !entries.length && <p>No saved images.</p>}
            <ul className="emoji-library-list">
              {entries.map((entry) => (
                <li key={entry.emoji}>
                  <button
                    type="button"
                    className="emoji-library-select"
                    disabled={disabled}
                    aria-label={`React with ${entry.custom.name}`}
                    onClick={() => onSelect(entry)}
                  >
                    <EmojiGlyph value={entry} />
                    <span>{entry.custom.name}</span>
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={disabled}
                    aria-label={`Remove ${entry.custom.name} from my images`}
                    onClick={() => save([], [entry.emoji])}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <Alert>{action.error || error}</Alert>
        <Alert success>{action.notice}</Alert>
      </div>
    </Modal>
  );
}
